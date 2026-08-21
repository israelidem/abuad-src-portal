/**
 * Admin routes — settings, maintenance mode, user management, analytics.
 *
 * Role rules enforced here:
 *   - Analytics: any staff member.
 *   - User management: ADMIN and above, with guardrails below.
 *   - Settings and maintenance mode: SUPER_ADMIN only. These change how
 *     the whole portal behaves, so they sit above day-to-day admin work.
 */

import express from 'express';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
// Needed by POST /users: account creation goes through Supabase Auth, the
// same path public signup uses, so both produce identical auth records.
import { supabaseAdmin } from '../lib/supabase.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  requireAuth,
  requireStaff,
  requireAdmin,
  requireSuperAdmin,
} from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { adminWriteLimiter } from '../middleware/rateLimiter.js';
// The role hierarchy, declared once. See config/roles.js for why these are
// not spelled out inline here any more.
import { ROLES, canManageAccount, canGrantRole } from '../config/roles.js';


import { getSettings, updateSettings } from '../services/settingsService.js';
import { invalidateUser } from '../services/authCache.js';
import { settingsSchema } from '../validators/settingsSchemas.js';
import { settingsManifest, toPublicSettings } from '../config/settingsRegistry.js';
import { recordAudit, changes } from '../services/auditService.js';
import {
  MODERATION_STATUS,
  MODERATION_ACTION,
  normaliseTerm,
  invalidateWordCache,
  recordModerationAction,
} from '../services/moderationService.js';

const router = express.Router();

/**
 * Local alias kept so existing call sites read unchanged.
 *
 * The implementation moved to services/auditService.js — ticket routes
 * need the same trail, and a helper defined inside this router couldn't be
 * reached from there.
 */
const audit = recordAudit;

// ------------------------------------------------------------
// Settings & maintenance mode — SUPER_ADMIN only
// ------------------------------------------------------------

/**
 * GET /api/admin/settings
 *
 * Returns the values *and* the manifest describing them — groups, labels,
 * types and help text, straight from the registry. The settings screen
 * renders from the manifest rather than a hard-coded form, so adding a
 * setting to the registry surfaces it in the UI without a frontend change.
 *
 * That also removes the failure mode where a setting existed in the
 * database and the validator but had no control on the page, leaving it
 * editable only by hand-crafted API calls.
 */
router.get(
  '/settings',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    res.json({
      settings: await getSettings({ fresh: true }),
      manifest: settingsManifest(),
    });
  })
);

router.patch(
  '/settings',
  requireAuth,
  requireSuperAdmin,
  // Not about distrusting super admins: it caps the blast radius if a
  // privileged session is stolen, and stops a looping script from
  // rewriting portal-wide config hundreds of times.
  adminWriteLimiter,
  validateBody(settingsSchema),

  asyncHandler(async (req, res) => {
    // Read once, up front: needed both for the domain guard below and as
    // the "previous value" side of the audit diff. Without it the trail
    // recorded only what was submitted, so "signups disabled" gave no way
    // to tell whether that was a change or a no-op re-save.
    const before = await getSettings({ fresh: true });

    // Turning on domain restriction with no allow-list would lock out
    // every new signup, including legitimate ones.
    if (req.body.restrictSignupDomains === true) {
      const domains = req.body.allowedDomains ?? before.allowedDomains;
      if (!domains?.length) {
        throw new ApiError(
          400,
          'Add at least one allowed domain before restricting signups, or nobody will be able to register.'
        );
      }
    }

    const settings = await updateSettings(req.body, req.user.id);

    // Field-by-field diff of what actually moved. These are the settings
    // the brief calls out by name — registration and maintenance mode —
    // and the ones most likely to need explaining after the fact.
    await audit(req, 'settings.update', 'AppSettings', '1', changes(before, req.body));

    res.json({ settings });
  })
);

/**
 * GET /api/admin/maintenance — public.
 *
 * The frontend needs some settings before sign-in — the maintenance banner,
 * the portal name, whether to render the registration form — so the subset
 * marked `public` in the registry is readable without a token. The domain
 * lists are deliberately not in that subset: publishing them would hand out
 * a map of which email suffixes are accepted.
 *
 * `allowStudentSignups` is safe to expose — it's a UI hint, not the control.
 * The actual rejection happens in POST /api/auth/signup, so a client that
 * ignores this response still cannot register.
 */
router.get(
  '/maintenance',
  asyncHandler(async (_req, res) => {
    // Narrowed by the registry rather than by a hand-written list. The old
    // version destructured four fields by name, so every new setting
    // needed remembering here — and a field added without thinking about
    // exposure would have been one careless spread away from public.
    //
    // toPublicSettings() is an allow-list: a new column stays private
    // until someone marks it `public` in the registry, so the failure mode
    // is a missing UI hint rather than a leak.
    res.json(toPublicSettings(await getSettings()));
  })
);

// ------------------------------------------------------------
// User management — ADMIN and above
// ------------------------------------------------------------

/*
 * Derived from ROLES so a new role cannot be silently unassignable.
 *
 * DEV is accepted by the schema but is *not* thereby grantable: canGrantRole
 * below refuses any role the caller does not itself hold, so only a DEV can
 * hand out DEV. Validating the shape and authorising the privilege are kept
 * separate on purpose — a 400 "unknown role" would wrongly suggest the role
 * does not exist.
 */
const roleSchema = z.object({
  role: z.enum(ROLES),
});


const activeSchema = z.object({ isActive: z.boolean() });

/**
 * Manual account creation by a SUPER_ADMIN.
 *
 * Deliberately stricter than the public signup schema in one respect —
 * `role` is accepted here and rejected there. Public signup strips any
 * client-supplied role (see identityUniqueness.test.mjs); this endpoint is
 * the only path that may set one, and only for a SUPER_ADMIN.
 */
const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  // 12 rather than the public minimum: an account minted for someone else
  // is handed over out-of-band, so it should not also be weak.
  password: z.string().min(12).max(128),
  fullName: z.string().trim().min(2).max(120),
  // From ROLES for the same reason as roleSchema. Authorisation is the
  // canGrantRole check in the handler, not this enum.
  role: z.enum(ROLES).default('STUDENT'),

  matricNumber: z.string().trim().max(50).optional().or(z.literal('')),
  faculty: z.string().trim().max(120).optional().or(z.literal('')),
  department: z.string().trim().max(120).optional().or(z.literal('')),
});

/**
 * POST /api/admin/users
 *
 * Creates an account when public registration is closed.
 *
 * SUPER_ADMIN only, not requireAdmin: this endpoint can mint another
 * SUPER_ADMIN, so allowing plain admins here would turn "manage users" into
 * a privilege-escalation path.
 *
 * Note what is intentionally *absent*: no `checkSignupAllowed`, and no
 * `checkEmailDomain`. Both exist to police self-service registration by
 * strangers. Applying them here would defeat the entire purpose — the
 * feature is specifically for the case where the public gate is shut, and a
 * super admin onboarding a guest lecturer on an external address is a
 * decision they are trusted to make.
 */
router.post(
  '/users',
  requireAuth,
  requireSuperAdmin,
  adminWriteLimiter,
  validateBody(createUserSchema),
  asyncHandler(async (req, res) => {
    const { email, password, fullName, role, matricNumber, faculty, department } = req.body;

    /*
     * The same "cannot grant what you do not hold" rule as /users/:id/role.
     *
     * This endpoint previously trusted its Zod enum, which topped out at
     * SUPER_ADMIN and made the omission harmless. Now that DEV exists,
     * creating an account is a second path to minting one, and an
     * account-creation hole is worse than a promotion hole: there is no
     * prior row and therefore nothing for assertCanManage to protect.
     */
    const grant = canGrantRole(req.user, role);
    if (!grant.allowed) throw new ApiError(403, grant.reason);

    // Same ordering as public signup, for the same reason: a duplicate

    // matric number found *after* the auth user exists would leave an
    // orphan, and the corrected retry would then fail on "email already
    // registered" — a confusing dead end for whoever is being onboarded.
    if (matricNumber) {
      const clash = await prisma.profile.findUnique({ where: { matricNumber } });
      if (clash) throw new ApiError(409, 'That matric number is already registered.');
    }

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      // Confirmed on creation: the account is being made *for* someone by
      // an authenticated super admin, so there is no address to verify and
      // no reason to make them wait on an email that may never arrive.
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        matric_number: matricNumber || null,
        faculty: faculty || null,
      },
    });

    if (error) {
      if (/already registered|already been registered/i.test(error.message)) {
        throw new ApiError(409, 'An account with this email already exists.');
      }
      throw new ApiError(400, error.message);
    }

    // The DB trigger creates the profile row with the default role, so the
    // requested role is applied here as an update rather than an insert.
    const profile = await prisma.profile.update({
      where: { id: data.user.id },
      data: {
        role,
        department: department || null,
        // Manually created accounts are active immediately; an inactive
        // account the admin then has to go and enable is a pointless step.
        isActive: true,
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        matricNumber: true,
        faculty: true,
        department: true,
        isActive: true,
        createdAt: true,
      },
    });

    // Who created whom, and with what role. Manual creation of a privileged
    // account is exactly the event an audit trail exists to capture.
    //
    // Positional signature — (req, action, entityType, entityId, metadata) —
    // matching every other audit call in this file. The email is recorded
    // because "which account was created" is the first question asked; the
    // password obviously is not.
    await audit(req, 'user.created_by_admin', 'Profile', profile.id, {
      email: profile.email,
      role,
    });

    // No password echoed back, not even the one just supplied: it would
    // land in browser devtools, any proxy log, and the response cache.
    res.status(201).json({ user: profile });
  })
);

router.get(
  '/users',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const search = (req.query.search || '').trim();
    const role = req.query.role;

    const where = {
      ...(role ? { role } : {}),
      ...(search
        ? {
            OR: [
              { email: { contains: search, mode: 'insensitive' } },
              { fullName: { contains: search, mode: 'insensitive' } },
              { matricNumber: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [users, total] = await Promise.all([
      prisma.profile.findMany({
        where,
        orderBy: [{ role: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          email: true,
          fullName: true,
          matricNumber: true,
          faculty: true,
          role: true,
          isActive: true,
          createdAt: true,
          _count: { select: { tickets: true } },
        },
      }),
      prisma.profile.count({ where }),
    ]);

    res.json({
      users: users.map(({ _count, ...u }) => ({ ...u, ticketCount: _count.tickets })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  })
);

/**
 * Shared guardrails for acting on another account.
 *
 * Two rules that matter:
 *   1. Nobody can act on themselves. Self-demotion and self-deactivation
 *      are the easiest ways to lock the portal's last admin out.
 *   2. Only a SUPER_ADMIN can touch another SUPER_ADMIN. Otherwise a
 *      regular ADMIN could demote the absolute admin and take over.
 */
const assertCanManage = (actor, target) => {
  if (!target) throw new ApiError(404, 'User not found.');

  /*
   * Delegated to config/roles.js. The two rules above are unchanged — they
   * are now expressed as ranks there — and a third is added with them: a
   * protected role (DEV) can only be managed by an equal or higher rank,
   * so a SUPER_ADMIN cannot demote, deactivate or delete a DEV.
   *
   * Centralised deliberately. This helper guards both /role and /status,
   * but the rule also has to hold for account deletion and any endpoint
   * added later; keeping the logic in one exported function is what makes
   * "check every account-management endpoint" a tractable claim rather
   * than a promise to grep carefully.
   */
  const decision = canManageAccount(actor, target);
  if (!decision.allowed) {
    // 400 for the self-management case (a client mistake, not a privilege
    // problem), 403 for the rest — preserving the status codes the admin
    // UI already distinguishes.
    throw new ApiError(actor.id === target.id ? 400 : 403, decision.reason);
  }
};


/** Refuses to remove the last SUPER_ADMIN, whatever the caller's role. */
const assertNotLastSuperAdmin = async (target) => {
  if (target.role !== 'SUPER_ADMIN') return;

  const remaining = await prisma.profile.count({
    where: { role: 'SUPER_ADMIN', isActive: true, id: { not: target.id } },
  });

  if (remaining === 0) {
    throw new ApiError(
      409,
      'This is the last active super admin. Promote another account first, or the portal will have no one who can restore access.'
    );
  }
};

router.patch(
  '/users/:id/role',
  requireAuth,
  requireAdmin,
  adminWriteLimiter,
  validateBody(roleSchema),

  asyncHandler(async (req, res) => {
    const target = await prisma.profile.findUnique({ where: { id: req.params.id } });
    assertCanManage(req.user, target);

    /*
     * You cannot grant a role you do not hold.
     *
     * This generalises the previous SUPER_ADMIN-only check. It still stops
     * an ADMIN promoting themselves a deputy, and it additionally stops a
     * SUPER_ADMIN minting a DEV — which matters because a DEV they created
     * would be an account they control but are then forbidden from
     * managing, i.e. a way to manufacture an untouchable admin.
     */
    const grant = canGrantRole(req.user, req.body.role);
    if (!grant.allowed) throw new ApiError(403, grant.reason);

    /*
     * Demoting a DEV is already refused by assertCanManage above (a
     * SUPER_ADMIN cannot manage a DEV at all). A DEV demoting another DEV
     * is permitted, deliberately: equal rank, same rule that already lets
     * one super admin demote another, with the DB trigger as the backstop.
     */


    if (target.role === 'SUPER_ADMIN' && req.body.role !== 'SUPER_ADMIN') {
      await assertNotLastSuperAdmin(target);
    }

    const user = await prisma.profile.update({
      where: { id: req.params.id },
      data: { role: req.body.role },
      select: { id: true, email: true, fullName: true, role: true, isActive: true },
    });

    // Immediately, and before responding. requireAuth caches resolved
    // sessions for a few seconds, so without this a demoted admin would
    // keep admin rights until the TTL lapsed — the exact failure that
    // turns a cache into a privilege-escalation bug.
    invalidateUser(user.id);

    await audit(req, 'user.role_change', 'Profile', user.id, {
      from: target.role,
      to: req.body.role,
    });

    res.json({ user });
  })
);

router.patch(
  '/users/:id/status',
  requireAuth,
  requireAdmin,
  adminWriteLimiter,
  validateBody(activeSchema),

  asyncHandler(async (req, res) => {
    const target = await prisma.profile.findUnique({ where: { id: req.params.id } });
    assertCanManage(req.user, target);

    if (req.body.isActive === false) await assertNotLastSuperAdmin(target);

    const user = await prisma.profile.update({
      where: { id: req.params.id },
      data: { isActive: req.body.isActive },
      select: { id: true, email: true, fullName: true, role: true, isActive: true },
    });

    // Same reasoning as the role change: a deactivated account must lose
    // access now, not once the session cache expires.
    invalidateUser(user.id);

    await audit(req, req.body.isActive ? 'user.reactivate' : 'user.deactivate', 'Profile', user.id);

    res.json({ user });
  })
);

// ------------------------------------------------------------
// Analytics — any staff member
// ------------------------------------------------------------

/**
 * GET /api/admin/analytics?days=30
 *
 * Counts are grouped in the database rather than fetched and reduced in
 * JS — the ticket table is the one that grows without bound here.
 */
router.get(
  '/analytics',
  requireAuth,
  requireStaff,
  asyncHandler(async (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 86_400_000);

    const [byStatus, byCategory, byUrgency, totals, resolved, ratings, topDepartments] =
      await Promise.all([
        prisma.ticket.groupBy({ by: ['status'], _count: true }),
        prisma.ticket.groupBy({ by: ['category'], _count: true, where: { createdAt: { gte: since } } }),
        prisma.ticket.groupBy({ by: ['urgency'], _count: true, where: { createdAt: { gte: since } } }),
        prisma.ticket.aggregate({
          _count: true,
          _sum: { upvoteCount: true, commentCount: true },
        }),
        // Resolution time, in the window, for tickets that actually closed.
        prisma.ticket.findMany({
          where: { resolvedAt: { not: null, gte: since } },
          select: { createdAt: true, resolvedAt: true, dueAt: true },
        }),
        prisma.ticketRating.aggregate({ _avg: { score: true }, _count: true }),
        prisma.ticket.groupBy({
          by: ['departmentId'],
          _count: true,
          where: { departmentId: { not: null }, createdAt: { gte: since } },
          orderBy: { _count: { departmentId: 'desc' } },
          take: 5,
        }),
      ]);

    // Average resolution time and SLA hit rate, derived in one pass.
    let totalMs = 0;
    let withinSla = 0;
    for (const t of resolved) {
      totalMs += t.resolvedAt.getTime() - t.createdAt.getTime();
      if (!t.dueAt || t.resolvedAt <= t.dueAt) withinSla += 1;
    }

    const avgResolutionHours = resolved.length
      ? Math.round((totalMs / resolved.length / 3_600_000) * 10) / 10
      : null;

    const slaCompliancePct = resolved.length
      ? Math.round((withinSla / resolved.length) * 100)
      : null;

    // Currently overdue: past due, not yet resolved.
    const overdue = await prisma.ticket.count({
      where: {
        dueAt: { lt: new Date() },
        status: { notIn: ['RESOLVED', 'CLOSED'] },
      },
    });

    // Resolve department names for the top-5 (groupBy can't join).
    const departments = topDepartments.length
      ? await prisma.department.findMany({
          where: { id: { in: topDepartments.map((d) => d.departmentId) } },
          select: { id: true, name: true },
        })
      : [];

    const nameById = new Map(departments.map((d) => [d.id, d.name]));

    const toMap = (rows, key) =>
      Object.fromEntries(rows.map((r) => [r[key], r._count]));

    /**
     * Daily submitted vs resolved.
     *
     * The totals above say how big the pile is; this says whether it is
     * growing. Bucketed in Postgres via date_trunc rather than pulling
     * every row back and grouping in JS — Prisma's groupBy cannot express
     * a truncated date, so this is raw SQL by necessity.
     *
     * Days with no activity are absent from both result sets, so the
     * series is padded below: a gap in a line chart reads as missing
     * data, while a zero is the actual answer.
     */
    const [createdRows, resolvedRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS count
        FROM public.tickets
        WHERE created_at >= ${since}
        GROUP BY 1
        ORDER BY 1
      `,
      prisma.$queryRaw`
        SELECT date_trunc('day', resolved_at)::date AS day, COUNT(*)::int AS count
        FROM public.tickets
        WHERE resolved_at IS NOT NULL AND resolved_at >= ${since}
        GROUP BY 1
        ORDER BY 1
      `,
    ]);

    const isoDay = (value) => new Date(value).toISOString().slice(0, 10);
    const createdByDay = new Map(createdRows.map((r) => [isoDay(r.day), r.count]));
    const resolvedByDay = new Map(resolvedRows.map((r) => [isoDay(r.day), r.count]));

    // A year of daily points is unreadable on a phone, so long windows
    // are reported weekly instead.
    const step = days > 90 ? 7 : 1;
    const trend = [];

    // Buckets are anchored at today and walk backwards, so when `days`
    // isn't a whole number of weeks the short bucket lands on the oldest
    // point. A short bucket at the newest end would draw a dip that
    // never happened — the very thing this chart is read for.
    for (let offset = 0; offset < days; offset += step) {
      const end = Math.min(offset + step, days);

      let created = 0;
      let closed = 0;
      for (let i = offset; i < end; i += 1) {
        const day = isoDay(Date.now() - i * 86_400_000);
        created += createdByDay.get(day) ?? 0;
        closed += resolvedByDay.get(day) ?? 0;
      }

      // Labelled with the bucket's oldest day, so a weekly point reads
      // as "the week beginning...".
      trend.push({
        date: isoDay(Date.now() - (end - 1) * 86_400_000),
        created,
        resolved: closed,
      });
    }

    trend.reverse(); // oldest first, the direction a chart is read

    res.json({
      windowDays: days,
      tickets: {
        total: totals._count,
        byStatus: toMap(byStatus, 'status'),
        byCategory: toMap(byCategory, 'category'),
        byUrgency: toMap(byUrgency, 'urgency'),
        totalUpvotes: totals._sum.upvoteCount ?? 0,
        totalComments: totals._sum.commentCount ?? 0,
      },
      performance: {
        resolvedInWindow: resolved.length,
        avgResolutionHours,
        slaCompliancePct,
        overdue,
      },
      satisfaction: {
        averageScore: ratings._avg.score ? Math.round(ratings._avg.score * 10) / 10 : null,
        responses: ratings._count,
      },
      topDepartments: topDepartments.map((d) => ({
        id: d.departmentId,
        name: nameById.get(d.departmentId) ?? 'Unknown',
        ticketCount: d._count,
      })),
      trend,
      trendGranularity: step === 1 ? 'day' : 'week',
    });
  })
);

/**
 * GET /api/admin/moderation — the flagged queue.
 *
 * Flagging already existed but nothing listed the results, so a flagged
 * ticket was only findable by whoever happened to flag it. Anonymous
 * authors stay anonymous here: the queue is for triage, and identity is
 * a separate, audited step below.
 */
router.get(
  '/moderation',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const tickets = await prisma.ticket.findMany({
      where: { isFlagged: true },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        ticketNumber: true,
        description: true,
        category: true,
        status: true,
        isAnonymous: true,
        flagReason: true,
        createdAt: true,
        updatedAt: true,
        author: { select: { id: true, fullName: true } },
      },
    });

    res.json({
      tickets: tickets.map(({ author, isAnonymous, ...t }) => ({
        ...t,
        isAnonymous,
        // Same rule as the public board. An admin who needs the name
        // asks for it explicitly and leaves a record by doing so.
        author: isAnonymous ? null : author,
      })),
    });
  })
);

/**
 * Comment moderation queue.
 *
 * Flagging wrote moderation columns from the first commit of this feature,
 * but nothing read them back — a flagged comment sat in PENDING with no
 * screen and no endpoint able to resolve it. These routes close that loop.
 *
 * Authorisation is `requireAdmin`, matching the ticket queue directly
 * above rather than inventing a second rule. Comment bodies here can be
 * abusive by definition and may come from anonymous authors, so this is
 * not a REP-level surface.
 */

const queueQuerySchema = z.object({
  // PENDING first because that is the only actionable state; the other
  // three are for reviewing what was already decided.
  status: z
    .enum([
      MODERATION_STATUS.PENDING,
      MODERATION_STATUS.APPROVED,
      MODERATION_STATUS.REJECTED,
      MODERATION_STATUS.RESOLVED,
    ])
    .default(MODERATION_STATUS.PENDING),
  page: z.coerce.number().int().min(1).max(500).default(1),
  // Capped. An unbounded ?limit= is how a moderation list becomes an
  // accidental full-table export.
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * GET /api/admin/moderation/comments?status=&page=&limit=
 *
 * Paginated because the queue grows without bound over a term and the
 * brief explicitly forbids loading every comment into one response.
 * Served by the (moderation_status, flagged_at) index added in migration 10.
 */
router.get(
  '/moderation/comments',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = queueQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'Invalid moderation queue filter.');
    }
    const { status, page, limit } = parsed.data;

    const where = { moderationStatus: status };

    // Two queries, not N+1: one page of rows plus one count for the pager.
    const [total, comments] = await Promise.all([
      prisma.ticketComment.count({ where }),
      prisma.ticketComment.findMany({
        where,
        // flaggedAt is null on rows that were never flagged (APPROVED by
        // default), so fall back to createdAt to keep ordering stable.
        orderBy: [{ flaggedAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          body: true,
          createdAt: true,
          flaggedAt: true,
          moderationStatus: true,
          moderationReason: true,
          moderationCategories: true,
          moderationSeverity: true,
          isHidden: true,
          moderatedAt: true,
          isInternal: true,
          author: { select: { id: true, fullName: true, role: true } },
          moderatedBy: { select: { id: true, fullName: true } },
          ticket: {
            select: { id: true, ticketNumber: true, title: true, isAnonymous: true },
          },
        },
      }),
    ]);

    res.json({
      comments: comments.map(({ ticket, author, ...c }) => ({
        ...c,
        ticket,
        // An anonymous ticket's comment thread inherits that anonymity.
        // Revealing the author here would be a back door around the
        // audited /tickets/:id/reveal step below.
        author: ticket?.isAnonymous ? null : author,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  })
);

const decisionSchema = z.object({
  action: z.enum(['approve', 'reject', 'resolve']),
  reason: z.string().trim().max(500).optional(),
});

/**
 * POST /api/admin/moderation/comments/:id/decision
 *
 * One endpoint for all three outcomes rather than three near-identical
 * ones, because the surrounding work — load, authorise, update, write the
 * audit row — is identical and only the target state differs.
 *
 *   approve  the filter was wrong (or the comment is acceptable) → visible
 *   reject   the comment stays hidden; this is the removal path
 *   resolve  reviewed and handled; visibility deliberately unchanged
 */
router.post(
  '/moderation/comments/:id/decision',
  requireAuth,
  requireAdmin,
  adminWriteLimiter,
  validateBody(decisionSchema),
  asyncHandler(async (req, res) => {
    const { action, reason } = req.body;

    // Rejecting removes a student's words from a thread. That needs a
    // recorded justification, the same standard the reveal route holds.
    if (action === 'reject' && (!reason || reason.length < 5)) {
      throw new ApiError(400, 'Record why this comment is being removed.');
    }

    const comment = await prisma.ticketComment.findUnique({
      where: { id: req.params.id },
      select: { id: true, moderationStatus: true, isHidden: true },
    });

    if (!comment) throw new ApiError(404, 'Comment not found.');

    const next = {
      approve: { moderationStatus: MODERATION_STATUS.APPROVED, isHidden: false },
      reject: { moderationStatus: MODERATION_STATUS.REJECTED, isHidden: true },
      // Visibility is left as-is: a resolved case may legitimately be
      // either hidden or visible, and guessing would silently republish
      // something a moderator hid on purpose.
      resolve: { moderationStatus: MODERATION_STATUS.RESOLVED, isHidden: comment.isHidden },
    }[action];

    const updated = await prisma.ticketComment.update({
      where: { id: comment.id },
      data: {
        ...next,
        moderatedById: req.user.id,
        moderatedAt: new Date(),
      },
      select: { id: true, moderationStatus: true, isHidden: true, moderatedAt: true },
    });

    // Audit trail. Best-effort inside the service: losing history must not
    // undo a decision the moderator already made.
    await recordModerationAction({
      commentId: comment.id,
      actorId: req.user.id,
      actorRole: req.user.role,
      action: {
        approve: MODERATION_ACTION.APPROVED,
        reject: MODERATION_ACTION.REJECTED,
        resolve: MODERATION_ACTION.RESOLVED,
      }[action],
      reason: reason ?? null,
      fromStatus: comment.moderationStatus,
      toStatus: updated.moderationStatus,
    });

    res.json({ comment: updated });
  })
);

/**
 * GET /api/admin/moderation/comments/:id/history
 *
 * The audit trail for one comment: who decided what, when, and why.
 */
router.get(
  '/moderation/comments/:id/history',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const actions = await prisma.moderationAction.findMany({
      where: { commentId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        action: true,
        reason: true,
        fromStatus: true,
        toStatus: true,
        actorRole: true,
        createdAt: true,
        actor: { select: { id: true, fullName: true } },
      },
    });

    res.json({ actions });
  })
);

/**
 * Admin-managed blocked words.
 *
 * The built-in list stays in version control; this table holds the
 * additions admins make at runtime. Every write invalidates the word
 * cache so the change applies to the next comment — the brief's
 * "no code deployment or restart" requirement.
 */

const wordSchema = z.object({
  term: z.string().trim().min(2, 'Enter the word or phrase to block.').max(120),
  category: z
    .enum(['PROFANITY', 'HATE_SPEECH', 'THREAT', 'SEXUAL', 'SELF_HARM', 'HARASSMENT', 'CUSTOM'])
    .default('CUSTOM'),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
  isEnabled: z.boolean().default(true),
  notes: z.string().trim().max(500).nullable().optional(),
});

// Edits arrive as partials, so every field is optional — but an empty body
// is a mistake, not a no-op update.
const wordPatchSchema = wordSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  'Nothing to update.'
);

/**
 * Guards against a term that would flag everything.
 *
 * "a" or "!!" normalise to something so short that the tolerant matcher
 * would fire on ordinary sentences, and the first symptom would be every
 * comment in the portal landing in the queue at once. Cheaper to refuse
 * here than to explain later.
 */
const assertUsableTerm = (term) => {
  const normalised = normaliseTerm(term);
  if (normalised.length < 3) {
    throw new ApiError(
      400,
      'That term is too short or has no letters — it would flag ordinary comments.'
    );
  }
  return normalised;
};

router.get(
  '/moderation/words',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const words = await prisma.moderationWord.findMany({
      orderBy: { createdAt: 'desc' },
      // Bounded. The list is admin-curated and small; a cap still keeps a
      // runaway import from becoming a multi-megabyte response.
      take: 500,
      select: {
        id: true,
        term: true,
        category: true,
        severity: true,
        isEnabled: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
        createdBy: { select: { id: true, fullName: true } },
      },
    });

    res.json({ words });
  })
);

router.post(
  '/moderation/words',
  requireAuth,
  requireAdmin,
  adminWriteLimiter,
  validateBody(wordSchema),
  asyncHandler(async (req, res) => {
    const { term, category, severity, isEnabled, notes } = req.body;
    const normalised = assertUsableTerm(term);

    try {
      const word = await prisma.moderationWord.create({
        data: {
          term,
          normalised,
          category,
          severity,
          isEnabled,
          notes: notes ?? null,
          createdById: req.user.id,
        },
        select: { id: true, term: true, category: true, severity: true, isEnabled: true },
      });

      // Immediately, and before responding: an admin who adds a word and
      // then tests it must see it take effect.
      invalidateWordCache();

      // Positional signature: (req, action, entityType, entityId, metadata).
      // Metadata is the term only, not the whole row — enough to answer
      // "who blocked this word" without copying abuse into the audit log.
      await audit(req, 'moderation.word_added', 'ModerationWord', word.id, {
        term: word.term,
        category,
        severity,
      });

      res.status(201).json({ word });
    } catch (error) {
      // Unique on `normalised`, so "Idiot" and "idiot " collide by design.
      if (error?.code === 'P2002') {
        throw new ApiError(409, 'That word or phrase is already on the list.');
      }
      throw error;
    }
  })
);

router.patch(
  '/moderation/words/:id',
  requireAuth,
  requireAdmin,
  adminWriteLimiter,
  validateBody(wordPatchSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.moderationWord.findUnique({
      where: { id: req.params.id },
      select: { id: true, term: true, category: true, severity: true, isEnabled: true, notes: true },
    });
    if (!existing) throw new ApiError(404, 'Word not found.');

    const data = { ...req.body };
    // Keep `normalised` consistent with `term`, or the uniqueness
    // guarantee quietly stops holding after the first edit.
    if (data.term !== undefined) data.normalised = assertUsableTerm(data.term);

    try {
      const word = await prisma.moderationWord.update({
        where: { id: existing.id },
        data,
        select: {
          id: true,
          term: true,
          category: true,
          severity: true,
          isEnabled: true,
          notes: true,
        },
      });

      invalidateWordCache();

      await audit(req, 'moderation.word_updated', 'ModerationWord', word.id, changes(existing, word));

      res.json({ word });
    } catch (error) {
      if (error?.code === 'P2002') {
        throw new ApiError(409, 'Another entry already covers that word or phrase.');
      }
      throw error;
    }
  })
);

router.delete(
  '/moderation/words/:id',
  requireAuth,
  requireAdmin,
  adminWriteLimiter,
  asyncHandler(async (req, res) => {
    const existing = await prisma.moderationWord.findUnique({
      where: { id: req.params.id },
      select: { id: true, term: true },
    });
    if (!existing) throw new ApiError(404, 'Word not found.');

    await prisma.moderationWord.delete({ where: { id: existing.id } });
    invalidateWordCache();

    await audit(req, 'moderation.word_deleted', 'ModerationWord', existing.id, {
      term: existing.term,
    });

    res.status(204).end();
  })
);

const revealSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, 'Record why this reveal is justified — at least 10 characters.')
    .max(500),
});

/**
 * POST /api/admin/tickets/:id/reveal
 *
 * Anonymity is promised to students, so breaking it cannot be a silent
 * side effect of opening a page. It requires an explicit request, a
 * written reason, and it writes an audit row naming the admin — which is
 * what makes the promise on the submission form ("administrators can
 * still trace serious abuse") both true and accountable.
 */
router.post(
  '/tickets/:id/reveal',
  requireAuth,
  requireAdmin,
  // De-anonymisation is the most sensitive action in the portal, so it is
  // also rate-limited: a stolen admin session should not be able to
  // enumerate the authors of every anonymous ticket in one burst.
  adminWriteLimiter,
  validateBody(revealSchema),

  asyncHandler(async (req, res) => {
    const ticket = await prisma.ticket.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        ticketNumber: true,
        isAnonymous: true,
        author: {
          select: { id: true, fullName: true, email: true, matricNumber: true },
        },
      },
    });

    if (!ticket) throw new ApiError(404, 'Ticket not found.');
    if (!ticket.isAnonymous) {
      throw new ApiError(400, 'This ticket is not anonymous — the author is already shown.');
    }

    // Awaited, unlike the fire-and-forget audits elsewhere. If we cannot
    // record the reveal we must not perform it, or the log stops being
    // evidence of anything.
    await prisma.auditLog.create({
      data: {
        actorId: req.user.id,
        action: 'ANONYMOUS_AUTHOR_REVEALED',
        entityType: 'ticket',
        entityId: ticket.id,
        metadata: {
          ticketNumber: ticket.ticketNumber,
          reason: req.body.reason,
          revealedUserId: ticket.author?.id ?? null,
        },
        ipAddress: req.ip,
      },
    });

    res.json({ author: ticket.author });
  })
);

// ------------------------------------------------------------
// Audit trail — SUPER_ADMIN only
// ------------------------------------------------------------

/**
 * GET /api/admin/audit
 *
 * The table was write-only until now: rows accumulated and nothing could
 * read them without database access, which makes an audit trail useless
 * for the person it exists to serve.
 *
 * SUPER_ADMIN rather than ADMIN, for two reasons. The trail records
 * admins' own actions, so it should not be readable by everyone it
 * describes. And reveal entries name the student behind an anonymous
 * ticket — the narrowest possible audience for that.
 */
router.get(
  '/audit',
  requireAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));

    // Narrow filters, because the useful question is usually "what
    // happened to this ticket" or "what has this admin changed".
    const where = {
      ...(req.query.action ? { action: req.query.action } : {}),
      ...(req.query.entityType ? { entityType: req.query.entityType } : {}),
      ...(req.query.entityId ? { entityId: req.query.entityId } : {}),
      ...(req.query.actorId ? { actorId: req.query.actorId } : {}),
    };

    const [entries, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          actor: { select: { id: true, fullName: true, email: true, role: true } },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      // Mapped to the shape the brief describes — admin, action, target,
      // timestamp, and the change itself — rather than raw columns.
      entries: entries.map((e) => ({
        id: e.id,
        admin: e.actor
          ? { id: e.actor.id, name: e.actor.fullName, role: e.actor.role }
          : null,
        action: e.action,
        target: { type: e.entityType, id: e.entityId },
        changes: e.metadata ?? null,
        ipAddress: e.ipAddress,
        timestamp: e.createdAt,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  })
);

export default router;
