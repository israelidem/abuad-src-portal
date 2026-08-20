/**
 * Announcements & polls.
 *
 * Announcements are drafts until published: `publishedAt` is null while
 * being written, so staff can prepare something without students seeing a
 * half-finished notice. Polls hang off an announcement or stand alone.
 */

import express from 'express';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, requireStaff, optionalAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { notifyMany } from '../services/pushService.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

/**
 * How long after publishing an announcement can still be edited.
 *
 * Students are notified the moment something is published, so the text
 * they were pushed and the text on the page must not drift. A short
 * window covers the typo you spot immediately; anything later should be
 * a new announcement rather than a silent rewrite of a notice people
 * have already read.
 */
const EDIT_WINDOW_MS = 10 * 60 * 1000;

/** Milliseconds left in the edit window, 0 once it has closed. */
const editWindowRemaining = (announcement) => {
  if (!announcement.publishedAt) return EDIT_WINDOW_MS; // drafts stay editable
  const elapsed = Date.now() - new Date(announcement.publishedAt).getTime();
  return Math.max(0, EDIT_WINDOW_MS - elapsed);
};

/**
 * Announces to every active student.
 *
 * Staff are skipped: they either wrote the notice or already saw it in
 * the drafts list, and reps get enough ticket traffic without also being
 * pinged by their own colleagues' announcements.
 */
async function broadcastAnnouncement(announcement) {
  const recipients = await prisma.profile.findMany({
    where: { isActive: true, role: 'STUDENT' },
    select: { id: true },
  });

  // Trimmed: the push payload shows on a lock screen, where a 5,000
  // character body would be truncated anyway.
  const preview =
    announcement.body.length > 140 ? `${announcement.body.slice(0, 137)}…` : announcement.body;

  await notifyMany(
    recipients.map((r) => r.id),
    {
      type: 'ANNOUNCEMENT',
      title: announcement.title,
      body: preview,
      link: '/announcements',
      tag: `announcement-${announcement.id}`,
    }
  );
}

const announcementSchema = z.object({
  title: z.string().trim().min(3).max(150),
  body: z.string().trim().min(3).max(5000),
  isPinned: z.boolean().default(false),
  publish: z.boolean().default(false),
});

const pollSchema = z.object({
  question: z.string().trim().min(3).max(300),
  options: z.array(z.string().trim().min(1).max(120)).min(2).max(10),
  closesAt: z.coerce.date().optional(),
  announcementId: z.string().uuid().optional(),
});

const voteSchema = z.object({ optionId: z.string().uuid() });

/** Hides who voted for what; students only ever see totals. */
const serialisePoll = (poll, myVote) => ({
  id: poll.id,
  question: poll.question,
  closesAt: poll.closesAt,
  isActive: poll.isActive && (!poll.closesAt || poll.closesAt > new Date()),
  totalVotes: poll.options.reduce((sum, o) => sum + o.voteCount, 0),
  options: poll.options.map((o) => ({
    id: o.id,
    label: o.label,
    voteCount: o.voteCount,
  })),
  myVoteOptionId: myVote?.optionId ?? null,
});

// ------------------------------------------------------------
// Announcements
// ------------------------------------------------------------

/** GET /api/announcements — published only, unless staff ask for drafts. */
router.get(
  '/',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const isStaff = ['REP', 'ADMIN', 'SUPER_ADMIN'].includes(req.user?.role);
    const includeDrafts = isStaff && req.query.includeDrafts === 'true';

    const announcements = await prisma.announcement.findMany({
      where: includeDrafts ? {} : { publishedAt: { not: null } },
      orderBy: [{ isPinned: 'desc' }, { publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: 50,
      include: {
        author: { select: { id: true, fullName: true, role: true } },
        polls: { include: { options: { orderBy: { position: 'asc' } } } },
      },
    });

    // One query for every vote this user has cast, rather than one per
    // poll — the N+1 would scale with the number of announcements shown.
    const myVotes = req.user
      ? await prisma.pollVote.findMany({
          where: { userId: req.user.id },
          select: { pollId: true, optionId: true },
        })
      : [];

    const voteByPoll = new Map(myVotes.map((v) => [v.pollId, v]));

    res.json({
      announcements: announcements.map((a) => ({
        id: a.id,
        title: a.title,
        body: a.body,
        isPinned: a.isPinned,
        publishedAt: a.publishedAt,
        createdAt: a.createdAt,
        author: a.author,
        // The window is the server's rule, so the server reports what's
        // left of it. A client counting from `publishedAt` itself would
        // drift with clock skew and offer an edit the API then rejects.
        editWindowMs: isStaff ? editWindowRemaining(a) : 0,
        polls: a.polls.map((p) => serialisePoll(p, voteByPoll.get(p.id))),
      })),
    });
  })
);

router.post(
  '/',
  requireAuth,
  requireStaff,
  validateBody(announcementSchema),
  asyncHandler(async (req, res) => {
    const { publish, ...data } = req.body;

    const announcement = await prisma.announcement.create({
      data: {
        ...data,
        authorId: req.user.id,
        publishedAt: publish ? new Date() : null,
      },
      include: { author: { select: { id: true, fullName: true, role: true } } },
    });

    // Drafts stay silent — that's the entire point of a draft.
    if (announcement.publishedAt) {
      // A failed fan-out must not turn a saved announcement into a 500;
      // the notice exists either way and can be re-broadcast.
      await broadcastAnnouncement(announcement).catch((error) => {
        // Non-fatal by design — the announcement is saved and can be
        // re-broadcast — but it needs to be findable afterwards. Carries
        // the announcement id so "students didn't get the notice" can be
        // traced to a specific publish.
        (req.log ?? logger).error('announcement.broadcast_failed', {
          announcementId: announcement.id,
          actorId: req.user?.id,
          phase: 'create',
          err: error,
        });
      });
    }

    res.status(201).json({
      announcement: { ...announcement, editWindowMs: editWindowRemaining(announcement) },
    });
  })
);

router.patch(
  '/:id',
  requireAuth,
  requireStaff,
  validateBody(announcementSchema.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.announcement.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Announcement not found.');

    const { publish, ...data } = req.body;

    // Enforced here rather than in the UI: hiding the button stops the
    // honest mistake, but only a server-side check actually holds.
    const isEditingContent = data.title !== undefined || data.body !== undefined;
    if (isEditingContent && existing.publishedAt && editWindowRemaining(existing) === 0) {
      throw new ApiError(
        403,
        'The 10-minute edit window has closed. Post a new announcement instead — students have already been notified about this one.'
      );
    }

    // Publishing is one-way here: unpublishing something students have
    // already been notified about causes more confusion than it solves.
    const isPublishingNow = publish === true && !existing.publishedAt;
    if (isPublishingNow) data.publishedAt = new Date();

    const announcement = await prisma.announcement.update({
      where: { id: req.params.id },
      data,
      include: { author: { select: { id: true, fullName: true, role: true } } },
    });

    // Only on the draft -> published transition. Editing an already-live
    // announcement must not notify everyone a second time.
    if (isPublishingNow) {
      await broadcastAnnouncement(announcement).catch((error) => {
        (req.log ?? logger).error('announcement.broadcast_failed', {
          announcementId: announcement.id,
          actorId: req.user?.id,
          phase: 'publish',
          err: error,
        });
      });
    }

    res.json({
      announcement: { ...announcement, editWindowMs: editWindowRemaining(announcement) },
    });
  })
);

router.delete(
  '/:id',
  requireAuth,
  requireStaff,
  asyncHandler(async (req, res) => {
    const existing = await prisma.announcement.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Announcement not found.');

    await prisma.announcement.delete({ where: { id: req.params.id } });
    res.json({ message: 'Announcement deleted.' });
  })
);

// ------------------------------------------------------------
// Polls
// ------------------------------------------------------------

router.post(
  '/polls',
  requireAuth,
  requireStaff,
  validateBody(pollSchema),
  asyncHandler(async (req, res) => {
    const { options, ...data } = req.body;

    const poll = await prisma.poll.create({
      data: {
        ...data,
        options: {
          create: options.map((label, position) => ({ label, position })),
        },
      },
      include: { options: { orderBy: { position: 'asc' } } },
    });

    res.status(201).json({ poll: serialisePoll(poll, null) });
  })
);

/**
 * POST /api/announcements/polls/:id/vote
 *
 * One vote per poll per user, enforced by a unique constraint. Changing
 * your mind updates the existing row; the vote_count trigger moves the
 * tally across.
 */
router.post(
  '/polls/:id/vote',
  requireAuth,
  validateBody(voteSchema),
  asyncHandler(async (req, res) => {
    const poll = await prisma.poll.findUnique({
      where: { id: req.params.id },
      include: { options: { orderBy: { position: 'asc' } } },
    });

    if (!poll) throw new ApiError(404, 'Poll not found.');
    if (!poll.isActive) throw new ApiError(409, 'This poll is closed.');
    if (poll.closesAt && poll.closesAt < new Date()) {
      throw new ApiError(409, 'This poll has closed.');
    }

    // Guards against voting for an option belonging to a different poll.
    if (!poll.options.some((o) => o.id === req.body.optionId)) {
      throw new ApiError(400, 'That option does not belong to this poll.');
    }

    await prisma.pollVote.upsert({
      where: { pollId_userId: { pollId: poll.id, userId: req.user.id } },
      update: { optionId: req.body.optionId },
      create: { pollId: poll.id, optionId: req.body.optionId, userId: req.user.id },
    });

    // Re-read so the response carries trigger-updated counts.
    const updated = await prisma.poll.findUnique({
      where: { id: poll.id },
      include: { options: { orderBy: { position: 'asc' } } },
    });

    res.json({
      poll: serialisePoll(updated, { optionId: req.body.optionId }),
    });
  })
);

router.patch(
  '/polls/:id/close',
  requireAuth,
  requireStaff,
  asyncHandler(async (req, res) => {
    const existing = await prisma.poll.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Poll not found.');

    const poll = await prisma.poll.update({
      where: { id: req.params.id },
      data: { isActive: false, closesAt: new Date() },
      include: { options: { orderBy: { position: 'asc' } } },
    });

    res.json({ poll: serialisePoll(poll, null) });
  })
);

export default router;
