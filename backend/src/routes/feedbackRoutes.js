/**
 * Portal feedback (§9) and portal ratings (§10).
 *
 * Two features in one router because they share a shape: a user submits a
 * small opinion about the portal, and staff read it in aggregate. Neither
 * belongs in ticketRoutes.js — a ticket is an SRC complaint routed to a
 * department, these are reports about the software.
 *
 * Authorisation, in one place so it can be audited:
 *   POST   /api/feedback            authenticated user
 *   GET    /api/feedback/mine       authenticated user, own rows only
 *   GET    /api/feedback            ADMIN+          (all rows, paginated)
 *   PATCH  /api/feedback/:id        ADMIN+          (status / notes)
 *   GET    /api/feedback/ratings/state    authenticated user
 *   POST   /api/feedback/ratings          authenticated user
 *   GET    /api/feedback/ratings/summary  ADMIN+
 *   GET    /api/feedback/ratings/list     ADMIN+
 *
 * requireAuth runs before requireAdmin on every staff route, so an
 * unauthenticated caller gets 401 and a student gets 403 — never a leak
 * of whether the row exists.
 */

import express from 'express';

import { prisma } from '../lib/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { feedbackLimiter, adminWriteLimiter } from '../middleware/rateLimiter.js';
import { recordAudit } from '../services/auditService.js';
import { evaluateComment } from '../services/moderationService.js';
import {
  createFeedbackSchema,
  updateFeedbackSchema,
  listFeedbackSchema,
  submitRatingSchema,
  listRatingsSchema,
  FEEDBACK_STATUSES,
} from '../validators/feedbackSchemas.js';

const router = express.Router();

/**
 * Fields safe to return to the submitting user.
 *
 * `adminNotes` and `resolvedById` are deliberately absent: triage notes
 * are written for colleagues ("probably the same as the iOS bug, low
 * priority") and showing them to the reporter would either offend or
 * leak internal process.
 */
const OWN_FEEDBACK_FIELDS = {
  id: true,
  category: true,
  subject: true,
  description: true,
  status: true,
  screenshotPath: true,
  createdAt: true,
  updatedAt: true,
};

// ------------------------------------------------------------
// §9 — submitting feedback
// ------------------------------------------------------------

/**
 * POST /api/feedback
 *
 * Rate limited by feedbackLimiter (see RATE_LIMITS.md) and additionally
 * by the daily cap below. The limiter stops a burst; the cap stops a slow
 * drip that would still fill the admin queue.
 */
router.post(
  '/',
  requireAuth,
  feedbackLimiter,
  validateBody(createFeedbackSchema),
  asyncHandler(async (req, res) => {
    const { category, subject, description, screenshotPath, pageUrl, appVersion } =
      req.body;

    /**
     * Daily cap, counted in the database rather than in memory.
     *
     * The rate limiter is per-process and resets on deploy; this survives
     * both. 10/day is far above honest use — a student reporting several
     * genuine bugs in one afternoon is welcome — and far below what would
     * make the queue unusable.
     */
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await prisma.portalFeedback.count({
      where: { userId: req.user.id, createdAt: { gte: since } },
    });

    if (recent >= 10) {
      throw new ApiError(
        429,
        'You have submitted a lot of feedback today. Please try again tomorrow.',
      );
    }

    /**
     * Reuse the comment moderation filter on the free-text fields.
     *
     * Feedback is not published to other students, so an abusive report
     * cannot harm a peer — but a queue full of slurs still has to be read
     * by a person. Flagged submissions are accepted and stored (the
     * complaint underneath may be real) and marked IN_REVIEW so they are
     * visibly triaged rather than silently dropped.
     *
     * A moderation failure must not block a bug report: evaluateComment
     * already swallows its own errors and returns "not flagged", so a
     * filter outage degrades to accepting everything rather than
     * rejecting everything.
     */
    const verdict = await evaluateComment(`${subject}\n${description}`);

    const feedback = await prisma.portalFeedback.create({
      data: {
        userId: req.user.id,
        category,
        subject,
        description,
        screenshotPath: screenshotPath || null,
        status: verdict.flagged ? 'IN_REVIEW' : 'NEW',
        /**
         * Read from the header, not from the body: a client-supplied user
         * agent is worthless for diagnosis and is one more untrusted
         * string to store.
         */
        userAgent: req.get('user-agent')?.slice(0, 500) || null,
        pageUrl: pageUrl || null,
        appVersion: appVersion || null,
        adminNotes: verdict.flagged
          ? `Auto-flagged by moderation filter: ${verdict.fields.moderationReason}`
          : null,
      },
      select: OWN_FEEDBACK_FIELDS,
    });

    /**
     * Audited so a deleted or edited report leaves a trace, and so a user
     * who floods the queue can be identified after the fact.
     */
    await recordAudit({
      actorId: req.user.id,
      action: 'FEEDBACK_SUBMITTED',
      entityType: 'PortalFeedback',
      entityId: feedback.id,
      metadata: { category, autoFlagged: verdict.flagged },
      ipAddress: req.ip,
    });

    res.status(201).json({ feedback });
  }),
);

/**
 * GET /api/feedback/mine
 *
 * Registered before GET / so Express does not have to disambiguate, and
 * scoped to req.user.id — the id is never read from the query string, so
 * there is no parameter to tamper with to see someone else's reports.
 */
router.get(
  '/mine',
  requireAuth,
  asyncHandler(async (req, res) => {
    const items = await prisma.portalFeedback.findMany({
      where: { userId: req.user.id },
      select: OWN_FEEDBACK_FIELDS,
      orderBy: { createdAt: 'desc' },
      // Bounded: "my submissions" is a short list by design, and an
      // unbounded findMany is how a heavy user becomes a slow query.
      take: 20,
    });

    res.json({ items });
  }),
);

// ------------------------------------------------------------
// §9 — admin review
// ------------------------------------------------------------

/**
 * GET /api/feedback  (ADMIN+)
 *
 * Cursor-paginated. `include` pulls the reporter in one query rather than
 * per row — the N+1 that the same list would cause if the frontend
 * fetched each author separately — and selects only the three fields the
 * queue displays, so an email/matric dump is not one forgotten `true`
 * away.
 */
router.get(
  '/',
  requireAuth,
  requireAdmin,
  validateQuery(listFeedbackSchema),
  asyncHandler(async (req, res) => {
    const { status, category, cursor, limit } = req.query;

    const where = {};
    if (status) where.status = status;
    if (category) where.category = category;

    const items = await prisma.portalFeedback.findMany({
      where,
      include: {
        user: { select: { id: true, fullName: true, email: true } },
        resolvedBy: { select: { id: true, fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      // +1 to detect a further page without a second COUNT query.
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;

    /**
     * Status counts for the filter tabs, in one grouped query instead of
     * four counts. Cheap because portal_feedback_status_created_idx covers
     * it.
     */
    const grouped = await prisma.portalFeedback.groupBy({
      by: ['status'],
      _count: { status: true },
    });

    const counts = Object.fromEntries(FEEDBACK_STATUSES.map((s) => [s, 0]));
    for (const row of grouped) counts[row.status] = row._count.status;

    res.json({
      items: page,
      counts,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    });
  }),
);

/**
 * PATCH /api/feedback/:id  (ADMIN+)
 *
 * Status transitions and triage notes.
 */
router.patch(
  '/:id',
  requireAuth,
  requireAdmin,
  adminWriteLimiter,
  validateBody(updateFeedbackSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, adminNotes } = req.body;

    const existing = await prisma.portalFeedback.findUnique({
      where: { id },
      select: { id: true, status: true },
    });

    if (!existing) throw ApiError.notFound('Feedback not found.');

    const data = {};
    if (status !== undefined) {
      data.status = status;
      /**
       * Stamp who closed it and when, but only on the transition into a
       * terminal state — re-saving a note on an already-resolved item
       * should not rewrite the resolver to whoever touched it last.
       */
      if (
        (status === 'RESOLVED' || status === 'CLOSED') &&
        existing.status !== 'RESOLVED' &&
        existing.status !== 'CLOSED'
      ) {
        data.resolvedById = req.user.id;
        data.resolvedAt = new Date();
      }
      // Reopening clears the stamp, so "resolved by" is never stale.
      if (status === 'NEW' || status === 'IN_REVIEW') {
        data.resolvedById = null;
        data.resolvedAt = null;
      }
    }
    if (adminNotes !== undefined) data.adminNotes = adminNotes;

    const updated = await prisma.portalFeedback.update({
      where: { id },
      data,
      include: {
        user: { select: { id: true, fullName: true, email: true } },
        resolvedBy: { select: { id: true, fullName: true } },
      },
    });

    await recordAudit({
      actorId: req.user.id,
      action: 'FEEDBACK_UPDATED',
      entityType: 'PortalFeedback',
      entityId: id,
      metadata: {
        fromStatus: existing.status,
        toStatus: status ?? existing.status,
        notesChanged: adminNotes !== undefined,
      },
      ipAddress: req.ip,
    });

    res.json({ feedback: updated });
  }),
);

// ------------------------------------------------------------
// §10 — portal ratings
// ------------------------------------------------------------

/**
 * How long a user must have had an account before the prompt may appear.
 *
 * The brief says "after they have used it for a reasonable amount of
 * time" and "not immediately after login". Account age is the honest
 * proxy available here: session duration lives in the client and would
 * reset on every reload, so a session-based gate would ask a student who
 * refreshes twice and never ask one who leaves a tab open.
 *
 * Three days means the rating reflects actual use rather than a first
 * impression of the login screen.
 */
const MIN_ACCOUNT_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Gap before a user who already answered is asked again.
 *
 * 180 days: long enough that nobody is nagged, short enough that opinion
 * after a redesign can still be measured. Applies to dismissals too — a
 * dismissal is an answer ("not now"), and re-prompting a day later is
 * exactly the annoyance the brief prohibits.
 */
const REPROMPT_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * GET /api/feedback/ratings/state
 *
 * The prompt asks the server whether to show itself. Deciding this on the
 * client would put the anti-nag rule in localStorage, where clearing site
 * data or switching device would resurrect the prompt — the brief
 * requires it to behave across sessions and devices.
 */
router.get(
  '/ratings/state',
  requireAuth,
  asyncHandler(async (req, res) => {
    const [profile, latest] = await Promise.all([
      prisma.profile.findUnique({
        where: { id: req.user.id },
        select: { createdAt: true },
      }),
      prisma.portalRating.findFirst({
        where: { userId: req.user.id },
        orderBy: { promptRound: 'desc' },
        select: { promptRound: true, createdAt: true },
      }),
    ]);

    const accountAge = profile ? Date.now() - profile.createdAt.getTime() : 0;
    const oldEnough = accountAge >= MIN_ACCOUNT_AGE_MS;

    // Next round is one past whatever they last answered, so a re-prompt
    // records a new row instead of colliding with the unique index.
    const promptRound = (latest?.promptRound ?? 0) + 1;
    const dueForRepeat = latest
      ? Date.now() - latest.createdAt.getTime() >= REPROMPT_AFTER_MS
      : true;

    res.json({
      shouldPrompt: oldEnough && dueForRepeat,
      promptRound,
    });
  }),
);

/**
 * POST /api/feedback/ratings
 *
 * Accepts a rating or a dismissal for the round the server nominates.
 * The round is recomputed here rather than taken from the body: trusting
 * a client-supplied round would let a script submit rounds 1..1000 and
 * stuff the average.
 */
router.post(
  '/ratings',
  requireAuth,
  feedbackLimiter,
  validateBody(submitRatingSchema),
  asyncHandler(async (req, res) => {
    const { stars, reason, dismissed, appVersion } = req.body;

    const latest = await prisma.portalRating.findFirst({
      where: { userId: req.user.id },
      orderBy: { promptRound: 'desc' },
      select: { promptRound: true, createdAt: true },
    });

    /**
     * Refuse a second answer inside the re-prompt window.
     *
     * 409 rather than 429: this is not "too fast", it is "already
     * answered", and the client should stop showing the prompt rather
     * than retry later.
     */
    if (latest && Date.now() - latest.createdAt.getTime() < REPROMPT_AFTER_MS) {
      throw ApiError.conflict('You have already responded to the rating prompt.');
    }

    const promptRound = (latest?.promptRound ?? 0) + 1;

    try {
      const rating = await prisma.portalRating.create({
        data: {
          userId: req.user.id,
          // 0 is the sentinel the DB CHECK pairs with dismissed = true.
          stars: dismissed ? 0 : stars,
          reason: dismissed ? null : reason || null,
          dismissed,
          promptRound,
          appVersion: appVersion || null,
        },
        select: { id: true, stars: true, dismissed: true, createdAt: true },
      });

      res.status(201).json({ rating });
    } catch (err) {
      /**
       * P2002 = unique violation on (user_id, prompt_round).
       *
       * Reachable when two submits race: both read the same `latest`, both
       * compute the same round, one wins. Translated to 409 so a
       * double-clicked button reads as "already recorded" rather than a
       * 500.
       */
      if (err?.code === 'P2002') {
        throw ApiError.conflict('Your rating has already been recorded.');
      }
      throw err;
    }
  }),
);

/**
 * GET /api/feedback/ratings/summary  (ADMIN+)
 *
 * Aggregates computed in the database, not by loading rows and reducing
 * in JavaScript — the latter is fine at 50 ratings and a memory problem
 * at 50,000.
 */
router.get(
  '/ratings/summary',
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const [aggregate, distribution, dismissals] = await Promise.all([
      prisma.portalRating.aggregate({
        where: { dismissed: false },
        _avg: { stars: true },
        _count: { id: true },
      }),
      prisma.portalRating.groupBy({
        by: ['stars'],
        where: { dismissed: false },
        _count: { stars: true },
      }),
      prisma.portalRating.count({ where: { dismissed: true } }),
    ]);

    const byStar = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const row of distribution) byStar[row.stars] = row._count.stars;

    res.json({
      average: aggregate._avg.stars
        ? Number(aggregate._avg.stars.toFixed(2))
        : null,
      total: aggregate._count.id,
      dismissals,
      distribution: byStar,
    });
  }),
);

/**
 * GET /api/feedback/ratings/list  (ADMIN+)
 *
 * The written reasons, which are the actionable part. Paginated for the
 * same reason as the feedback queue.
 */
router.get(
  '/ratings/list',
  requireAuth,
  requireAdmin,
  validateQuery(listRatingsSchema),
  asyncHandler(async (req, res) => {
    const { includeDismissed, minStars, cursor, limit } = req.query;

    const where = {};
    if (!includeDismissed) where.dismissed = false;
    if (minStars) where.stars = { gte: minStars };

    const items = await prisma.portalRating.findMany({
      where,
      select: {
        id: true,
        stars: true,
        reason: true,
        dismissed: true,
        promptRound: true,
        appVersion: true,
        createdAt: true,
        user: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;

    res.json({
      items: page,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    });
  }),
);

export default router;
