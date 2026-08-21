/**
 * Ticket business logic.
 *
 * Route handlers stay thin; the rules that must never be bypassed live
 * here. Two of these are security-critical:
 *
 *   serialiseTicket() — strips author identity from anonymous tickets.
 *     `authorId` is always stored (so abuse can be traced by an admin),
 *     which means anonymity is an *API-layer* guarantee. Every response
 *     path must go through this function.
 *
 *   canViewTicket() / canEditTicket() — the old app decided this in React
 *     state, so anyone could flip themselves to admin. Now it's derived
 *     from the database role on every request.
 */

import { prisma } from '../lib/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../lib/logger.js';
import { isStaffRole, isAdminRole } from '../config/roles.js';


/** Hours to resolve, by urgency. Drives the SLA countdown and overdue flag. */
const SLA_HOURS = {
  HIGH: 24,
  MEDIUM: 72,
  LOW: 168, // one week
};

export const calculateDueDate = (urgency, from = new Date()) => {
  const hours = SLA_HOURS[urgency] ?? SLA_HOURS.MEDIUM;
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
};

/**
 * Staff = anyone who can act on other people's tickets.
 *
 * Exported because routes need the same test when gating staff-only
 * fields on a shared endpoint. Keep this as the single definition — a
 * second copy is how a new role gets missed in one place.
 */
/**
 * SUPER_ADMIN outranks ADMIN, and DEV outranks SUPER_ADMIN, so both count
 * as staff everywhere ADMIN does. Delegated to config/roles.js so there is
 * one list to change rather than one per file.
 */
export const isStaffUser = (user) => isStaffRole(user);


const isStaff = isStaffUser;

/** Only these transitions are legal. Anything else is a 400. */
const ALLOWED_TRANSITIONS = {
  PENDING: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['RESOLVED', 'CLOSED', 'PENDING'],
  RESOLVED: ['CLOSED', 'REOPENED'],
  CLOSED: ['REOPENED'],
  REOPENED: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
};

export const assertValidTransition = (from, to) => {
  if (from === to) {
    throw new ApiError(400, `Ticket is already ${to.toLowerCase().replace('_', ' ')}.`);
  }
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new ApiError(
      400,
      `Cannot move a ${from.toLowerCase().replace('_', ' ')} ticket to ${to
        .toLowerCase()
        .replace('_', ' ')}.`
    );
  }
};

/** Author, assignee and staff can see private tickets. Everyone else needs isPublic. */
export const canViewTicket = (ticket, user) => {
  if (ticket.isPublic && !ticket.isFlagged) return true;
  if (!user) return false;
  if (isStaff(user)) return true;
  if (ticket.authorId === user.id) return true;
  if (ticket.assignedToId === user.id) return true;
  return false;
};

/**
 * Students may edit their own ticket only while it's still PENDING —
 * once staff have engaged, the record needs to stay stable.
 * Admins can always edit.
 */
/** ADMIN and above — SUPER_ADMIN and DEV must never have fewer rights than ADMIN. */
const isAdminUser = (user) => isAdminRole(user);

/**
 * ------------------------------------------------------------
 * Comment rules
 * ------------------------------------------------------------
 */

/**
 * Statuses in which the discussion is closed to students.
 *
 * Tied to the lifecycle state, not to anything the frontend decides.
 * RESOLVED and CLOSED are both terminal from a student's point of view:
 * the work is finished and the thread is a record of it. REOPENED is
 * deliberately absent — reopening a report is precisely the act of saying
 * "this is not finished", so it must reopen the discussion with it.
 *
 * CLOSED was already refused by the POST handler with a bespoke check;
 * that check is subsumed here so both statuses go through one rule.
 */
export const COMMENTS_LOCKED_STATUSES = ['RESOLVED', 'CLOSED'];

/** True when the report's own state has closed the student discussion. */
export const areCommentsLocked = (ticket) =>
  COMMENTS_LOCKED_STATUSES.includes(ticket?.status);

/**
 * Whether `user` may post a comment on `ticket`.
 *
 * Staff keep their existing permissions: a rep or admin can still add a
 * closing note, an internal note, or answer a follow-up question after
 * resolution. Removing that would break the existing workflow where
 * status changes carry a note (see the `note` handling in
 * PATCH /:id/status, which writes a comment as the actor). The
 * requirement is that *students* can no longer add to a resolved thread.
 *
 * Returns a reason so the API message and the UI's explanation come from
 * the same place.
 */
export const canCommentOnTicket = (ticket, user) => {
  if (!user) {
    return { allowed: false, reason: 'Sign in to join the discussion.' };
  }

  // Staff are unaffected by the resolved lock.
  if (isStaff(user)) return { allowed: true, reason: null };

  if (areCommentsLocked(ticket)) {
    return {
      allowed: false,
      reason:
        ticket.status === 'RESOLVED'
          ? 'This report has been resolved, so comments are now closed.'
          : 'This report is closed, so comments are now closed.',
    };
  }

  return { allowed: true, reason: null };
};

/**
 * How long a student has to delete their own comment.
 *
 * Thirty minutes, measured from the stored `createdAt`. That column is
 * written by the database (`default(now())`), so the window is anchored to
 * server time and a client cannot widen it by lying about the clock —
 * which is the whole reason the check is not `Date.now()` against a
 * client-supplied timestamp.
 */
export const COMMENT_DELETE_WINDOW_MS = 30 * 60 * 1000;

/** Milliseconds left in the deletion window; 0 once it has passed. */
export const commentDeleteMsRemaining = (comment, now = new Date()) => {
  const created = new Date(comment.createdAt).getTime();
  const elapsed = now.getTime() - created;
  return Math.max(0, COMMENT_DELETE_WINDOW_MS - elapsed);
};

/**
 * Whether `user` may delete `comment`.
 *
 * Three separate rules, deliberately not collapsed:
 *
 *   Staff (REP and above) delete under the existing moderation rules,
 *   with no time limit. That is pre-existing behaviour and moderation
 *   would be useless with a 30-minute expiry — abuse is often reported
 *   long after it is posted.
 *
 *   The author may delete their own comment, but only inside the window.
 *
 *   Everybody else, never. Note the ownership test comes before the
 *   window test, so another student's expired comment and another
 *   student's fresh comment produce the same refusal — the response must
 *   not become an oracle for other people's comment timestamps.
 */
export const canDeleteComment = (comment, user, now = new Date()) => {
  if (!user) return { allowed: false, reason: 'Sign in to manage your comments.' };

  if (isStaff(user)) return { allowed: true, reason: null, isModeration: true };

  if (comment.authorId !== user.id) {
    return { allowed: false, reason: 'You can only delete your own comments.' };
  }

  if (commentDeleteMsRemaining(comment, now) <= 0) {
    return {
      allowed: false,
      reason:
        'The 30-minute window for deleting this comment has passed. Ask an SRC admin if it needs removing.',
    };
  }

  return { allowed: true, reason: null, isModeration: false };
};


export const canEditTicket = (ticket, user) => {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  if (ticket.authorId !== user.id) return false;
  return ticket.status === 'PENDING';
};

export const canDeleteTicket = (ticket, user) => {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  return ticket.authorId === user.id && ticket.status === 'PENDING';
};

/** What Prisma should select for an author, when identity is shown at all. */
export const authorSelect = {
  id: true,
  fullName: true,
  avatarUrl: true,
  role: true,
  department: true,
};

export const ticketInclude = {
  author: { select: authorSelect },
  assignedTo: { select: authorSelect },
  departmentRef: { select: { id: true, name: true, slug: true } },
  attachments: {
    select: { id: true, storagePath: true, thumbPath: true, mimeType: true, sizeBytes: true },
  },
  /*
   * The resolution rating, if the reporter has left one.
   *
   * This is the fix for "the feedback request keeps coming back". The row
   * was always written, and `ticket_ratings.ticket_id` is UNIQUE so a
   * second one was always refused — but the ticket payload never carried
   * it. ResolutionActions initialises its `rated` flag from
   * `ticket.rating`, which was therefore permanently undefined, so the
   * form re-appeared on every mount: refresh, re-login, navigate away and
   * back. The state was persisted all along; it simply was not being
   * read. Including it here fixes all four cases at once, from the
   * database, without a new table or any client-side storage.
   */
  rating: { select: { id: true, score: true, comment: true, createdAt: true } },
  _count: { select: { comments: true, votes: true } },
};


/**
 * Converts a ticket row into an API response.
 *
 * Anonymity is applied here and nowhere else. Staff see a
 * `hasHiddenAuthor` marker so the UI can label the ticket, but still
 * never receive the identity — only the audit log links the two.
 */
export const serialiseTicket = (ticket, viewer = null, { hasVoted = null } = {}) => {
  if (!ticket) return null;

  const viewerIsStaff = isStaff(viewer);
  const viewerIsAuthor = viewer?.id === ticket.authorId;

  const overdue =
    ticket.dueAt != null &&
    !['RESOLVED', 'CLOSED'].includes(ticket.status) &&
    new Date(ticket.dueAt) < new Date();

  const base = {
    id: ticket.id,
    ticketNumber: ticket.ticketNumber,
    faculty: ticket.faculty,
    category: ticket.category,
    description: ticket.description,
    urgency: ticket.urgency,
    status: ticket.status,

    location: {
      text: ticket.locationText,
      lat: ticket.locationLat ?? null,
      lng: ticket.locationLng ?? null,
    },

    department: ticket.departmentRef ?? null,
    assignedTo: ticket.assignedTo ?? null,

    // Raw foreign keys alongside the nested objects. Without these the
    // client can't pre-select a <select> or tell "unassigned" from
    // "assigned to someone I can't see", so edit forms silently reset
    // to a blank value and then submit that blank as a real change.
    departmentId: ticket.departmentId ?? null,
    assignedToId: ticket.assignedToId ?? null,

    dueAt: ticket.dueAt,
    isOverdue: overdue,
    resolvedAt: ticket.resolvedAt,
    closedAt: ticket.closedAt,

    upvoteCount: ticket._count?.votes ?? ticket.upvoteCount ?? 0,
    commentCount: ticket._count?.comments ?? ticket.commentCount ?? 0,

    isPublic: ticket.isPublic,
    isAnonymous: ticket.isAnonymous,

    attachments: ticket.attachments ?? [],

    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,

    /*
     * The reporter's resolution rating, when one exists.
     *
     * Only the reporter and staff see it: for the reporter it is what
     * suppresses the feedback form for good, and for staff it is the
     * service-quality signal they act on. A third party reading a public
     * ticket has no business with it.
     *
     * `null` (not `undefined`) when absent, so the client can distinguish
     * "loaded, not rated" from "not loaded" — the difference between
     * showing the form and showing nothing yet.
     */
    rating:
      ticket.rating && (viewerIsAuthor || viewerIsStaff)
        ? {
            score: ticket.rating.score,
            comment: ticket.rating.comment ?? null,
            createdAt: ticket.rating.createdAt,
          }
        : null,

    // Lets the client render the right controls without duplicating rules
    permissions: {
      canEdit: canEditTicket(ticket, viewer),
      canDelete: canDeleteTicket(ticket, viewer),
      canManage: viewerIsStaff,
      /*
       * `canComment` was `Boolean(viewer)` — "signed in" — which is why a
       * resolved report still showed a comment box. It now carries the
       * real answer, from the same function the POST handler enforces
       * with, so the button and the API can never disagree.
       */
      canComment: canCommentOnTicket(ticket, viewer).allowed,
      /*
       * Why the discussion is closed, for the UI to explain itself.
       * Null when it is open, so the client tests one field rather than
       * re-deriving the rule from `status`.
       */
      commentsLockedReason: areCommentsLocked(ticket)
        ? canCommentOnTicket(ticket, viewer).reason
        : null,
    },
  };


  if (hasVoted !== null) base.hasVoted = hasVoted;

  // Flag reason is an internal moderation note
  if (viewerIsStaff) {
    base.isFlagged = ticket.isFlagged;
    base.flagReason = ticket.flagReason;
  }

  if (ticket.isAnonymous && !viewerIsAuthor) {
    base.author = null;
    base.isOwnTicket = false;
    if (viewerIsStaff) base.hasHiddenAuthor = true;
    return base;
  }

  base.author = ticket.author ?? null;
  base.isOwnTicket = viewerIsAuthor;
  return base;
};

/** Internal comments are stripped for anyone who isn't staff. */
export const serialiseComment = (comment, viewer = null) => {
  if (!comment) return null;

  const viewerIsStaff = isStaff(viewer);
  const isOwnComment = viewer?.id === comment.authorId;

  return {
    id: comment.id,
    body: comment.body,
    author: comment.author ?? null,
    isInternal: comment.isInternal,
    isEdited: comment.isEdited,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,

    // Moderation state is staff-only, with one deliberate exception: the
    // author is told their own comment is under review. Without that they
    // see a comment nobody replies to and file a support ticket about it.
    //
    // `moderationReason` quotes the terms that matched, so it goes to
    // staff ONLY — showing it to the author hands them a working recipe
    // for rewording past the filter.
    ...(viewerIsStaff
      ? {
          moderationStatus: comment.moderationStatus ?? 'APPROVED',
          moderationReason: comment.moderationReason ?? null,
          moderationCategories: comment.moderationCategories ?? [],
          moderationSeverity: comment.moderationSeverity ?? null,
          isHidden: comment.isHidden ?? false,
          moderatedAt: comment.moderatedAt ?? null,
          flaggedAt: comment.flaggedAt ?? null,
        }
      : isOwnComment && comment.moderationStatus && comment.moderationStatus !== 'APPROVED'
        ? { moderationStatus: comment.moderationStatus, isHidden: comment.isHidden ?? false }
        : {}),

    permissions: {
      canEdit: isOwnComment || isAdminUser(viewer),
      /*
       * Was `isOwnComment || viewerIsStaff`, i.e. an author could delete
       * their own comment forever. The 30-minute window is now applied
       * from the same helper the DELETE handler uses, so what the UI
       * offers and what the API permits are the same decision.
       */
      canDelete: canDeleteComment(comment, viewer).allowed,
    },

    /*
     * When the author's deletion window closes, as an absolute instant.
     *
     * Sent as an ISO timestamp derived from the server's own clock rather
     * than as "minutes left", so a client whose clock is wrong shows the
     * wrong countdown but still cannot delete late — the server re-checks
     * regardless. Omitted entirely once the window has passed or for
     * anyone but the author, so it never leaks other people's timings.
     */
    ...(isOwnComment && !viewerIsStaff && commentDeleteMsRemaining(comment) > 0
      ? {
          deletableUntil: new Date(
            new Date(comment.createdAt).getTime() + COMMENT_DELETE_WINDOW_MS
          ).toISOString(),
        }
      : {}),
  };
};



/**
 * Timeline entry. Actors are always shown — staff actions are
 * accountable — but an anonymous author's own CREATED event is masked.
 */
export const serialiseEvent = (event, ticket) => ({
  id: event.id,
  type: event.type,
  from: event.fromValue,
  to: event.toValue,
  metadata: event.metadata ?? null,
  actor:
    ticket?.isAnonymous && event.actorId === ticket.authorId
      ? null
      : event.actor ?? null,
  createdAt: event.createdAt,
});

/** Records a timeline entry. Never throws — an audit failure must not fail the action. */
export const recordEvent = async (client, { ticketId, actorId, type, from, to, metadata }) => {
  try {
    await client.ticketEvent.create({
      data: {
        ticketId,
        actorId: actorId ?? null,
        type,
        fromValue: from ?? null,
        toValue: to ?? null,
        metadata: metadata ?? undefined,
      },
    });
  } catch (err) {
    // The timeline is the ticket's audit trail, so a silent gap here is a
    // gap in the record of who did what. Still non-fatal — the status
    // change itself must not be rolled back — but it leaves a trace now.
    logger.error('ticket.event_record_failed', { ticketId, type, actorId, err });
  }
};

/** Maps the `sort` allowlist to Prisma orderBy. */
export const buildOrderBy = (sort) => {
  switch (sort) {
    case 'oldest':
      return [{ createdAt: 'asc' }];
    case 'most_voted':
      return [{ upvoteCount: 'desc' }, { createdAt: 'desc' }];
    case 'most_discussed':
      return [{ commentCount: 'desc' }, { createdAt: 'desc' }];
    case 'due_soon':
      // Unset due dates sort last rather than first
      return [{ dueAt: { sort: 'asc', nulls: 'last' } }];
    case 'urgency':
      // HIGH → LOW happens to be reverse-alphabetical
      return [{ urgency: 'desc' }, { createdAt: 'desc' }];
    case 'newest':
    default:
      return [{ createdAt: 'desc' }];
  }
};

/**
 * Translates list filters into a Prisma `where`.
 *
 * Visibility is applied first and cannot be overridden by query
 * parameters: anonymous callers only ever see public, unflagged tickets.
 */
export const buildWhere = (query, viewer) => {
  const {
    status,
    category,
    urgency,
    departmentId,
    assignedToId,
    faculty,
    q,
    scope,
    includePrivate,
    mine,
    overdue,
  } = query;

  // `?mine=true` is the alias the dashboard has always sent. Treated as
  // scope=mine so both spellings resolve to the same filter.
  const effectiveScope = scope === 'all' && mine ? 'mine' : scope;

  const where = { AND: [] };

  if (isStaff(viewer)) {
    // Staff see private and anonymous submissions by default — they are
    // the people meant to action them. Only an explicit
    // `includePrivate=false` narrows the view to the public board.
    //
    // This was the anonymous-feedback bug: `includePrivate` defaulted to
    // false, so `isPublic: true` was appended to *every* staff query and
    // private reports never reached an admin screen.
    if (includePrivate === false) where.AND.push({ isPublic: true });
  } else if (viewer) {
    where.AND.push({
      OR: [
        { isPublic: true, isFlagged: false },
        { authorId: viewer.id },
        { assignedToId: viewer.id },
      ],
    });
  } else {
    where.AND.push({ isPublic: true, isFlagged: false });
  }

  if (effectiveScope === 'mine') {
    if (!viewer) throw new ApiError(401, 'Sign in to view your tickets.');
    // Anonymous tickets still match here: authorId is retained on the row
    // precisely so a student keeps access to what they filed. Anonymity is
    // applied on the way out by serialiseTicket, not by dropping the link.
    where.AND.push({ authorId: viewer.id });
  } else if (effectiveScope === 'assigned') {
    if (!isStaff(viewer)) throw new ApiError(403, 'Only SRC staff have an assigned queue.');
    where.AND.push({ assignedToId: viewer.id });
  }

  if (status) where.AND.push({ status });
  if (category) where.AND.push({ category });
  if (urgency) where.AND.push({ urgency });
  if (departmentId) where.AND.push({ departmentId });
  if (assignedToId) where.AND.push({ assignedToId });
  if (faculty) where.AND.push({ faculty: { contains: faculty, mode: 'insensitive' } });

  // Past the SLA deadline and not yet closed out. RESOLVED/CLOSED are
  // excluded because a ticket that was answered late is no longer an
  // action item — leaving them in made the "needs attention" queue mostly
  // historical noise.
  if (overdue) {
    where.AND.push({
      dueAt: { not: null, lt: new Date() },
      status: { notIn: ['RESOLVED', 'CLOSED'] },
    });
  }

  if (q) {
    where.AND.push({
      OR: [
        { description: { contains: q, mode: 'insensitive' } },
        { locationText: { contains: q, mode: 'insensitive' } },
        { ticketNumber: { contains: q, mode: 'insensitive' } },
        { faculty: { contains: q, mode: 'insensitive' } },
      ],
    });
  }

  return where.AND.length ? where : {};
};

/** Loads a ticket and enforces view permission in one step. */
export const getTicketOrThrow = async (id, viewer, { include = ticketInclude } = {}) => {
  const ticket = await prisma.ticket.findUnique({ where: { id }, include });

  if (!ticket) throw new ApiError(404, 'Ticket not found.');

  // 404 rather than 403 — don't confirm a hidden ticket exists
  if (!canViewTicket(ticket, viewer)) throw new ApiError(404, 'Ticket not found.');

  return ticket;
};
