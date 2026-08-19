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
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  requireAuth,
  requireStaff,
  requireAdmin,
  requireSuperAdmin,
} from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { getSettings, updateSettings } from '../services/settingsService.js';
import { invalidateUser } from '../services/authCache.js';
import { settingsSchema } from '../validators/settingsSchemas.js';
import { settingsManifest, toPublicSettings } from '../config/settingsRegistry.js';

const router = express.Router();

/** Records who changed what. Failure here must not fail the action. */
const audit = async (req, action, entityType, entityId, metadata) => {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: req.user.id,
        action,
        entityType,
        entityId: entityId ?? null,
        metadata: metadata ?? undefined,
        ipAddress: req.ip,
      },
    });
  } catch {
    // Losing an audit row is bad; failing the request the admin asked for
    // because of it is worse.
  }
};

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
  validateBody(settingsSchema),
  asyncHandler(async (req, res) => {
    // Turning on domain restriction with no allow-list would lock out
    // every new signup, including legitimate ones.
    if (req.body.restrictSignupDomains === true) {
      const current = await getSettings({ fresh: true });
      const domains = req.body.allowedDomains ?? current.allowedDomains;
      if (!domains?.length) {
        throw new ApiError(
          400,
          'Add at least one allowed domain before restricting signups, or nobody will be able to register.'
        );
      }
    }

    const settings = await updateSettings(req.body, req.user.id);
    await audit(req, 'settings.update', 'AppSettings', '1', req.body);

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

const roleSchema = z.object({
  role: z.enum(['STUDENT', 'REP', 'ADMIN', 'SUPER_ADMIN']),
});

const activeSchema = z.object({ isActive: z.boolean() });

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

  if (target.id === actor.id) {
    throw new ApiError(
      400,
      'You cannot change your own role or status. Ask another admin to do it.'
    );
  }

  if (target.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') {
    throw new ApiError(403, 'Only a super admin can modify another super admin.');
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
  validateBody(roleSchema),
  asyncHandler(async (req, res) => {
    const target = await prisma.profile.findUnique({ where: { id: req.params.id } });
    assertCanManage(req.user, target);

    // Granting SUPER_ADMIN is itself a super-admin action — an ADMIN
    // promoting themselves a deputy would be a privilege escalation.
    if (req.body.role === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      throw new ApiError(403, 'Only a super admin can grant super admin.');
    }

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

export default router;
