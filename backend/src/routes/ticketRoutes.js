/**
 * Ticket routes.
 *
 * Handlers stay thin — permissions, anonymity and workflow rules live in
 * services/ticketService.js. Every response goes through serialiseTicket()
 * so an anonymous author can never leak through a new endpoint.
 */

import express from 'express';

import { prisma } from '../lib/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, optionalAuth, requireStaff, requireAdmin } from '../middleware/auth.js';
import { createTicketLimiter, interactionLimiter } from '../middleware/rateLimiter.js';
import { validateBody, validateQuery, validateParams } from '../middleware/validate.js';
import { notify } from '../services/pushService.js';
import { getSettings } from '../services/settingsService.js';
import {
  createTicketSchema,
  updateTicketSchema,
  updateTicketStatusSchema,
  assignTicketSchema,
  flagTicketSchema,
  createCommentSchema,
  updateCommentSchema,
  listTicketsQuerySchema,
  ticketIdParamSchema,
  createRatingSchema,
  reopenTicketSchema,
} from '../validators/ticketSchemas.js';
import {
  calculateDueDate,
  assertValidTransition,
  canEditTicket,
  canDeleteTicket,
  isStaffUser,
  ticketInclude,
  authorSelect,
  serialiseTicket,
  serialiseComment,
  serialiseEvent,
  recordEvent,
  buildOrderBy,
  buildWhere,
  getTicketOrThrow,
} from '../services/ticketService.js';

const router = express.Router();

/**
 * Human-readable status names for notification copy. The enum values are
 * fine in JSON but "IN_PROGRESS" reads badly on a lock screen.
 */
const STATUS_LABELS = {
  PENDING: 'Pending',
  IN_PROGRESS: 'In Progress',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
};

/**
 * GET /api/tickets
 * Public board. Signed-in callers additionally see their own private
 * tickets; staff can opt into all private tickets with includePrivate.
 */
router.get(
  '/',
  optionalAuth,
  validateQuery(listTicketsQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, limit, sort } = req.query;
    const viewer = req.user ?? null;

    const where = buildWhere(req.query, viewer);
    const skip = (page - 1) * limit;

    const [total, tickets] = await Promise.all([
      prisma.ticket.count({ where }),
      prisma.ticket.findMany({
        where,
        include: ticketInclude,
        orderBy: buildOrderBy(sort),
        skip,
        take: limit,
      }),
    ]);

    // One query for the viewer's votes across this page, rather than N+1
    let votedIds = new Set();
    if (viewer && tickets.length) {
      const votes = await prisma.ticketVote.findMany({
        where: { userId: viewer.id, ticketId: { in: tickets.map((t) => t.id) } },
        select: { ticketId: true },
      });
      votedIds = new Set(votes.map((v) => v.ticketId));
    }

    res.json({
      tickets: tickets.map((t) =>
        serialiseTicket(t, viewer, { hasVoted: viewer ? votedIds.has(t.id) : null })
      ),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
        hasNext: skip + tickets.length < total,
        hasPrev: page > 1,
      },
    });
  })
);

/**
 * GET /api/tickets/stats
 * Counts for the dashboard. Defined before /:id so "stats" isn't
 * captured as a ticket ID.
 */
router.get(
  '/stats',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const viewer = req.user ?? null;
    // Mirrors the list endpoint's filters so the counts describe the list
    // the user is actually looking at.
    //
    // Previously hardcoded to `{ scope: 'all', includePrivate: false }`,
    // which caused two visible defects:
    //
    //   * The student dashboard sends `?mine=true`. Forcing scope 'all'
    //     meant "My reports" summarised the entire public board, so the
    //     tiles never matched the list beneath them.
    //   * `includePrivate: false` appended `isPublic: true` for staff too,
    //     so private and anonymous submissions were missing from every
    //     admin total — the same root cause as the anonymous-ticket bug.
    const where = buildWhere(
      {
        scope: 'all',
        mine: req.query.mine === 'true' || req.query.mine === true,
        includePrivate: req.query.includePrivate === 'false' ? false : undefined,
      },
      viewer
    );

    const [byStatus, byCategory, byUrgency, total, overdue] = await Promise.all([
      prisma.ticket.groupBy({ by: ['status'], where, _count: true }),
      prisma.ticket.groupBy({ by: ['category'], where, _count: true }),
      prisma.ticket.groupBy({ by: ['urgency'], where, _count: true }),
      prisma.ticket.count({ where }),
      prisma.ticket.count({
        where: {
          AND: [
            where,
            { dueAt: { lt: new Date() } },
            { status: { notIn: ['RESOLVED', 'CLOSED'] } },
          ],
        },
      }),
    ]);

    const tally = (rows, key) =>
      rows.reduce((acc, r) => ({ ...acc, [r[key]]: r._count }), {});

    res.json({
      total,
      overdue,
      byStatus: tally(byStatus, 'status'),
      byCategory: tally(byCategory, 'category'),
      byUrgency: tally(byUrgency, 'urgency'),
    });
  })
);

/**
 * POST /api/tickets
 * ticket_number is assigned by a Postgres sequence, so concurrent
 * submissions can't collide.
 */
router.post(
  '/',
  requireAuth,
  createTicketLimiter,
  validateBody(createTicketSchema),
  asyncHandler(async (req, res) => {
    const { attachments, ...data } = req.body;

    /**
     * Portal policy, enforced server-side.
     *
     * The submission form also hides the anonymity checkbox and caps the
     * picker, but the form is not the boundary — these checks are what
     * actually hold when someone posts straight to the API.
     *
     * Read fresh: an admin turning anonymity off wants it off now, not up
     * to CACHE_TTL_MS later. Ticket creation is rate-limited and far less
     * frequent than the maintenance check the cache exists for, so the
     * extra round-trip is affordable here.
     */
    const { allowAnonymousTickets, maxAttachmentsPerTicket } = await getSettings({ fresh: true });

    if (data.isAnonymous && !allowAnonymousTickets) {
      throw new ApiError(403, 'Anonymous submissions are currently disabled.');
    }

    if (attachments && attachments.length > maxAttachmentsPerTicket) {
      throw new ApiError(
        400,
        `You can attach at most ${maxAttachmentsPerTicket} file${maxAttachmentsPerTicket === 1 ? '' : 's'}.`
      );
    }

    if (data.departmentId) {
      const dept = await prisma.department.findUnique({ where: { id: data.departmentId } });
      if (!dept || !dept.isActive) throw new ApiError(400, 'That department is not available.');

      // The form now asks only "which department?", so the category is
      // derived from that choice. An explicit category still wins, which
      // keeps older clients working and lets staff override the mapping
      // when one department handles more than one kind of issue.
      data.category ??= dept.category;
    }

    // Belt and braces. The validator already requires one of the two, but
    // a department row predating the category column would leave us
    // inserting null into a NOT NULL column — a 500 where a sensible
    // default costs nothing.
    data.category ??= 'OTHER';

    const ticket = await prisma.$transaction(async (tx) => {
      const created = await tx.ticket.create({
        data: {
          ...data,
          authorId: req.user.id,
          dueAt: calculateDueDate(data.urgency),
          attachments: attachments?.length ? { create: attachments } : undefined,
        },
        include: ticketInclude,
      });

      await recordEvent(tx, {
        ticketId: created.id,
        actorId: req.user.id,
        type: 'CREATED',
        to: created.status,
      });

      return created;
    });

    res.status(201).json({ ticket: serialiseTicket(ticket, req.user, { hasVoted: false }) });
  })
);

/** GET /api/tickets/:id */
router.get(
  '/:id',
  optionalAuth,
  validateParams(ticketIdParamSchema),
  asyncHandler(async (req, res) => {
    const viewer = req.user ?? null;
    const ticket = await getTicketOrThrow(req.params.id, viewer);

    const hasVoted = viewer
      ? Boolean(
          await prisma.ticketVote.findUnique({
            where: { ticketId_userId: { ticketId: ticket.id, userId: viewer.id } },
            select: { id: true },
          })
        )
      : null;

    res.json({ ticket: serialiseTicket(ticket, viewer, { hasVoted }) });
  })
);

/** GET /api/tickets/:id/timeline */
router.get(
  '/:id/timeline',
  optionalAuth,
  validateParams(ticketIdParamSchema),
  asyncHandler(async (req, res) => {
    const viewer = req.user ?? null;
    const ticket = await getTicketOrThrow(req.params.id, viewer, {
      include: { author: { select: { id: true } } },
    });

    const events = await prisma.ticketEvent.findMany({
      where: { ticketId: ticket.id },
      include: { actor: { select: authorSelect } },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ events: events.map((e) => serialiseEvent(e, ticket)) });
  })
);

/** PATCH /api/tickets/:id — author edits, PENDING only (admins exempt). */
router.patch(
  '/:id',
  requireAuth,
  validateParams(ticketIdParamSchema),
  validateBody(updateTicketSchema),
  asyncHandler(async (req, res) => {
    const ticket = await getTicketOrThrow(req.params.id, req.user);

    if (!canEditTicket(ticket, req.user)) {
      throw new ApiError(
        403,
        ticket.authorId === req.user.id
          ? 'Tickets can only be edited while still pending.'
          : 'You can only edit your own tickets.'
      );
    }

    // Changing urgency re-derives the SLA target
    const data = { ...req.body };
    if (data.urgency && data.urgency !== ticket.urgency) {
      data.dueAt = calculateDueDate(data.urgency, ticket.createdAt);
    }

    // Routing is a staff decision. Students editing their own ticket must
    // not be able to send it to a department of their choosing.
    if ('departmentId' in data) {
      if (!isStaffUser(req.user)) {
        throw new ApiError(403, 'Only SRC staff can route a ticket to a department.');
      }
      if (data.departmentId) {
        const dept = await prisma.department.findUnique({ where: { id: data.departmentId } });
        if (!dept || !dept.isActive) throw new ApiError(400, 'That department is not available.');
      }
    }

    const updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data,
      include: ticketInclude,
    });

    res.json({ ticket: serialiseTicket(updated, req.user) });
  })
);

/** PATCH /api/tickets/:id/status — staff only. */
router.patch(
  '/:id/status',
  requireAuth,
  requireStaff,
  validateParams(ticketIdParamSchema),
  validateBody(updateTicketStatusSchema),
  asyncHandler(async (req, res) => {
    const { status, note, departmentId } = req.body;
    const ticket = await getTicketOrThrow(req.params.id, req.user);

    assertValidTransition(ticket.status, status);

    const data = { status };
    if (status === 'RESOLVED') data.resolvedAt = new Date();
    if (status === 'CLOSED') data.closedAt = new Date();
    if (status === 'REOPENED') {
      data.resolvedAt = null;
      data.closedAt = null;
    }

    // Re-routing can accompany a status change. Both land in one
    // transaction so a failure can't leave the status moved but the
    // department stale.
    const reroute = departmentId !== undefined && departmentId !== ticket.departmentId;
    let toDepartmentName = null;
    if (reroute) {
      if (departmentId) {
        const dept = await prisma.department.findUnique({ where: { id: departmentId } });
        if (!dept || !dept.isActive) throw new ApiError(400, 'That department is not available.');
        toDepartmentName = dept.name;
      }
      data.departmentId = departmentId;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.ticket.update({
        where: { id: ticket.id },
        data,
        include: ticketInclude,
      });

      await recordEvent(tx, {
        ticketId: ticket.id,
        actorId: req.user.id,
        type: status === 'REOPENED' ? 'REOPENED' : 'STATUS_CHANGED',
        from: ticket.status,
        to: status,
        metadata: note ? { note } : undefined,
      });

      // A reroute is its own fact. Folding it into the status event would
      // lose it entirely when the status didn't change, and the reporter
      // would see a ticket sitting with a new office and no explanation.
      if (reroute) {
        await recordEvent(tx, {
          ticketId: ticket.id,
          actorId: req.user.id,
          type: 'DEPARTMENT_CHANGED',
          from: ticket.departmentId,
          to: departmentId,
          // from/to hold UUIDs, which mean nothing to a student reading
          // the timeline. The name is denormalised here so the entry stays
          // readable even if the department is later renamed or deleted.
          metadata: { toName: toDepartmentName ?? 'Unassigned' },
        });
      }

      if (note) {
        await tx.ticketComment.create({
          data: { ticketId: ticket.id, authorId: req.user.id, body: note },
        });
      }

      return result;
    });

    // After commit — a notification for a rolled-back change would be a
    // lie, and the author doesn't need telling about their own action.
    if (ticket.authorId !== req.user.id) {
      const label = STATUS_LABELS[status] ?? status;
      await notify(ticket.authorId, {
        type: status === 'RESOLVED' ? 'TICKET_RESOLVED' : 'STATUS_CHANGED',
        title: `${ticket.ticketNumber} is now ${label}`,
        body: note ?? `Your report was moved to ${label}.`,
        link: `/tickets/${ticket.id}`,
        // One tag per ticket, so five updates collapse into one entry
        // rather than burying the phone in notifications.
        tag: `ticket-${ticket.id}`,
      });
    }

    res.json({ ticket: serialiseTicket(updated, req.user) });
  })
);

/** PATCH /api/tickets/:id/assign — staff only. */
router.patch(
  '/:id/assign',
  requireAuth,
  requireStaff,
  validateParams(ticketIdParamSchema),
  validateBody(assignTicketSchema),
  asyncHandler(async (req, res) => {
    const { assignedToId } = req.body;
    const ticket = await getTicketOrThrow(req.params.id, req.user);

    if (assignedToId) {
      const assignee = await prisma.profile.findUnique({ where: { id: assignedToId } });
      if (!assignee) throw new ApiError(404, 'That user does not exist.');
      if (assignee.role === 'STUDENT') {
        throw new ApiError(400, 'Tickets can only be assigned to SRC representatives.');
      }
      if (!assignee.isActive) throw new ApiError(400, 'That account is deactivated.');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.ticket.update({
        where: { id: ticket.id },
        data: { assignedToId },
        include: ticketInclude,
      });

      await recordEvent(tx, {
        ticketId: ticket.id,
        actorId: req.user.id,
        type: assignedToId ? 'ASSIGNED' : 'UNASSIGNED',
        from: ticket.assignedToId,
        to: assignedToId,
      });

      return result;
    });

    // Tell the rep they've picked up work — they aren't watching the
    // board waiting for a ticket to land on them.
    if (assignedToId && assignedToId !== req.user.id) {
      await notify(assignedToId, {
        type: 'ASSIGNED',
        title: `${ticket.ticketNumber} assigned to you`,
        body: ticket.description.slice(0, 120),
        link: `/tickets/${ticket.id}`,
        tag: `ticket-${ticket.id}`,
      });
    }

    res.json({ ticket: serialiseTicket(updated, req.user) });
  })
);

/** PATCH /api/tickets/:id/flag — moderation, admin only. */
router.patch(
  '/:id/flag',
  requireAuth,
  requireAdmin,
  validateParams(ticketIdParamSchema),
  validateBody(flagTicketSchema),
  asyncHandler(async (req, res) => {
    const { isFlagged, reason } = req.body;
    const ticket = await getTicketOrThrow(req.params.id, req.user);

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.ticket.update({
        where: { id: ticket.id },
        data: { isFlagged, flagReason: isFlagged ? reason ?? null : null },
        include: ticketInclude,
      });

      await recordEvent(tx, {
        ticketId: ticket.id,
        actorId: req.user.id,
        type: isFlagged ? 'FLAGGED' : 'UNFLAGGED',
        metadata: reason ? { reason } : undefined,
      });

      return result;
    });

    res.json({ ticket: serialiseTicket(updated, req.user) });
  })
);

/** DELETE /api/tickets/:id — author while PENDING, or admin. */
router.delete(
  '/:id',
  requireAuth,
  validateParams(ticketIdParamSchema),
  asyncHandler(async (req, res) => {
    const ticket = await getTicketOrThrow(req.params.id, req.user);

    if (!canDeleteTicket(ticket, req.user)) {
      throw new ApiError(403, 'This ticket can no longer be deleted.');
    }

    // Comments, votes, events and attachments cascade at the DB level
    await prisma.ticket.delete({ where: { id: ticket.id } });

    res.json({ message: 'Ticket deleted.' });
  })
);

// ------------------------------------------------------------
// Votes — "I'm affected too"
// ------------------------------------------------------------

/** POST /api/tickets/:id/vote — idempotent toggle. */
router.post(
  '/:id/vote',
  requireAuth,
  interactionLimiter,
  validateParams(ticketIdParamSchema),
  asyncHandler(async (req, res) => {
    const ticket = await getTicketOrThrow(req.params.id, req.user, {
      include: { author: { select: { id: true } } },
    });

    if (ticket.authorId === req.user.id) {
      throw new ApiError(400, 'You cannot upvote your own ticket.');
    }

    const key = { ticketId_userId: { ticketId: ticket.id, userId: req.user.id } };
    const existing = await prisma.ticketVote.findUnique({ where: key, select: { id: true } });

    if (existing) {
      await prisma.ticketVote.delete({ where: key });
    } else {
      await prisma.ticketVote.create({ data: { ticketId: ticket.id, userId: req.user.id } });
    }

    // Counter is maintained by a trigger — read it back rather than guess
    const { upvoteCount } = await prisma.ticket.findUnique({
      where: { id: ticket.id },
      select: { upvoteCount: true },
    });

    res.json({ hasVoted: !existing, upvoteCount });
  })
);

// ------------------------------------------------------------
// Comments
// ------------------------------------------------------------

/** GET /api/tickets/:id/comments — internal notes filtered out for students. */
router.get(
  '/:id/comments',
  optionalAuth,
  validateParams(ticketIdParamSchema),
  asyncHandler(async (req, res) => {
    const viewer = req.user ?? null;
    const ticket = await getTicketOrThrow(req.params.id, viewer, {
      include: { author: { select: { id: true } } },
    });

    const staff = isStaffUser(viewer);

    const comments = await prisma.ticketComment.findMany({
      where: {
        ticketId: ticket.id,
        ...(staff ? {} : { isInternal: false }),
      },
      include: { author: { select: authorSelect } },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ comments: comments.map((c) => serialiseComment(c, viewer)) });
  })
);

/** POST /api/tickets/:id/comments */
router.post(
  '/:id/comments',
  requireAuth,
  interactionLimiter,
  validateParams(ticketIdParamSchema),
  validateBody(createCommentSchema),
  asyncHandler(async (req, res) => {
    const ticket = await getTicketOrThrow(req.params.id, req.user, {
      include: { author: { select: { id: true } } },
    });

    if (ticket.status === 'CLOSED') {
      throw new ApiError(400, 'This ticket is closed. Reopen it to continue the discussion.');
    }

    // isInternal is staff-only regardless of what the client sends
    const staff = isStaffUser(req.user);
    const isInternal = staff && req.body.isInternal === true;

    const comment = await prisma.$transaction(async (tx) => {
      const created = await tx.ticketComment.create({
        data: {
          ticketId: ticket.id,
          authorId: req.user.id,
          body: req.body.body,
          isInternal,
        },
        include: { author: { select: authorSelect } },
      });

      // Internal notes stay off the public timeline
      if (!isInternal) {
        await recordEvent(tx, {
          ticketId: ticket.id,
          actorId: req.user.id,
          type: 'COMMENTED',
        });
      }

      return created;
    });

    // Internal notes are staff-only, so notifying the student about one
    // would leak both its existence and its contents.
    if (!isInternal) {
      // Staff replying notifies the reporter; the reporter replying
      // notifies whoever is handling it. Nobody hears about their own
      // comment.
      const recipientId = req.user.id === ticket.authorId ? ticket.assignedToId : ticket.authorId;

      if (recipientId && recipientId !== req.user.id) {
        await notify(recipientId, {
          type: 'NEW_COMMENT',
          title: `New comment on ${ticket.ticketNumber}`,
          body: req.body.body.slice(0, 120),
          link: `/tickets/${ticket.id}`,
          tag: `ticket-${ticket.id}`,
        });
      }
    }

    res.status(201).json({ comment: serialiseComment(comment, req.user) });
  })
);

/** PATCH /api/tickets/:id/comments/:commentId — author only. */
router.patch(
  '/:id/comments/:commentId',
  requireAuth,
  validateBody(updateCommentSchema),
  asyncHandler(async (req, res) => {
    const comment = await prisma.ticketComment.findUnique({
      where: { id: req.params.commentId },
      include: { author: { select: authorSelect } },
    });

    if (!comment || comment.ticketId !== req.params.id) {
      throw new ApiError(404, 'Comment not found.');
    }
    if (comment.authorId !== req.user.id) {
      throw new ApiError(403, 'You can only edit your own comments.');
    }

    const updated = await prisma.ticketComment.update({
      where: { id: comment.id },
      data: { body: req.body.body, isEdited: true },
      include: { author: { select: authorSelect } },
    });

    res.json({ comment: serialiseComment(updated, req.user) });
  })
);

/** DELETE /api/tickets/:id/comments/:commentId — author or staff. */
router.delete(
  '/:id/comments/:commentId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const comment = await prisma.ticketComment.findUnique({
      where: { id: req.params.commentId },
    });

    if (!comment || comment.ticketId !== req.params.id) {
      throw new ApiError(404, 'Comment not found.');
    }

    const staff = isStaffUser(req.user);
    if (comment.authorId !== req.user.id && !staff) {
      throw new ApiError(403, 'You can only delete your own comments.');
    }

    await prisma.ticketComment.delete({ where: { id: comment.id } });

    res.json({ message: 'Comment deleted.' });
  })
);

// ------------------------------------------------------------
// Satisfaction rating & reopen (Phase 4b)
// ------------------------------------------------------------

/**
 * POST /api/tickets/:id/rating
 *
 * Only the reporter rates, and only once a ticket is actually resolved —
 * rating an open ticket would measure impatience, not service. The unique
 * constraint on ticket_id makes the "once" part real.
 */
router.post(
  '/:id/rating',
  requireAuth,
  interactionLimiter,
  validateParams(ticketIdParamSchema),
  validateBody(createRatingSchema),
  asyncHandler(async (req, res) => {
    const ticket = await getTicketOrThrow(req.params.id);

    if (ticket.authorId !== req.user.id) {
      throw new ApiError(403, 'Only the person who reported this can rate it.');
    }

    if (!['RESOLVED', 'CLOSED'].includes(ticket.status)) {
      throw new ApiError(409, 'You can rate this once it has been resolved.');
    }

    const existing = await prisma.ticketRating.findUnique({
      where: { ticketId: ticket.id },
    });
    if (existing) throw new ApiError(409, 'You have already rated this report.');

    const rating = await prisma.$transaction(async (tx) => {
      const created = await tx.ticketRating.create({
        data: {
          ticketId: ticket.id,
          userId: req.user.id,
          score: req.body.score,
          comment: req.body.comment ?? null,
        },
      });

      await recordEvent(tx, {
        ticketId: ticket.id,
        actorId: req.user.id,
        type: 'RATED',
        to: String(req.body.score),
      });

      return created;
    });

    // Tell whoever handled it. Praise is as useful as complaint, and
    // silence after a fix is what makes reps stop caring.
    if (ticket.assignedToId) {
      await notify(ticket.assignedToId, {
        type: 'TICKET_RESOLVED',
        title: `${req.body.score}★ rating on ${ticket.ticketNumber}`,
        body: req.body.comment || 'The reporter rated your resolution.',
        link: `/tickets/${ticket.id}`,
      }).catch(() => {});
    }

    res.status(201).json({ rating });
  })
);

/**
 * PATCH /api/tickets/:id/reopen
 *
 * The reporter's escape hatch for "marked resolved, still broken" —
 * without it their only option is filing a duplicate, which loses the
 * history and inflates the numbers.
 */
router.patch(
  '/:id/reopen',
  requireAuth,
  interactionLimiter,
  validateParams(ticketIdParamSchema),
  validateBody(reopenTicketSchema),
  asyncHandler(async (req, res) => {
    const ticket = await getTicketOrThrow(req.params.id);

    const isOwner = ticket.authorId === req.user.id;
    if (!isOwner && !isStaffUser(req.user)) {
      throw new ApiError(403, 'Only the reporter or SRC staff can reopen this.');
    }

    if (!['RESOLVED', 'CLOSED'].includes(ticket.status)) {
      throw new ApiError(409, 'This report is already open.');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const t = await tx.ticket.update({
        where: { id: ticket.id },
        data: {
          status: 'REOPENED',
          // Cleared so the ticket doesn't still look resolved in
          // analytics, and so resolution time is measured from the
          // real fix rather than the premature one.
          resolvedAt: null,
          closedAt: null,
        },
        include: ticketInclude,
      });

      await recordEvent(tx, {
        ticketId: ticket.id,
        actorId: req.user.id,
        type: 'REOPENED',
        from: ticket.status,
        to: 'REOPENED',
        metadata: { reason: req.body.reason },
      });

      return t;
    });

    // Notify the assignee, or nobody will know it bounced back.
    if (ticket.assignedToId && ticket.assignedToId !== req.user.id) {
      await notify(ticket.assignedToId, {
        type: 'STATUS_CHANGED',
        title: `${ticket.ticketNumber} was reopened`,
        body: req.body.reason,
        link: `/tickets/${ticket.id}`,
      }).catch(() => {});
    }

    res.json({ ticket: serialiseTicket(updated, req.user) });
  })
);

/**
 * GET /api/tickets/track/:ticketNumber — no auth.
 *
 * Lets a student check progress from a shared ticket number without an
 * account. Deliberately minimal: status and timestamps only, no
 * description, no comments, no author. The ticket number is guessable
 * (SRC-000142), so anything returned here is effectively public.
 */
router.get(
  '/track/:ticketNumber',
  asyncHandler(async (req, res) => {
    const ticketNumber = String(req.params.ticketNumber || '').trim().toUpperCase();

    const ticket = await prisma.ticket.findUnique({
      where: { ticketNumber },
      select: {
        ticketNumber: true,
        status: true,
        category: true,
        urgency: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true,
        isPublic: true,
        departmentRef: { select: { name: true } },
      },
    });

    // Same response either way: a 404 that differs from "private" would
    // confirm the ticket exists to anyone enumerating numbers.
    if (!ticket || !ticket.isPublic) {
      throw new ApiError(404, 'No public report found with that number.');
    }

    const { isPublic: _isPublic, departmentRef, ...rest } = ticket;
    res.json({ ticket: { ...rest, department: departmentRef?.name ?? null } });
  })
);

export default router;
