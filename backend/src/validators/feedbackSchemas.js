/**
 * Validators for portal feedback (§9) and portal ratings (§10).
 *
 * Every bound here is enforced server-side. The frontend has matching
 * `maxLength` attributes for a better typing experience, but those are a
 * courtesy to honest users — an attacker posting straight to the API
 * never sees them, so the limits below are the real ones.
 */

import { z } from 'zod';

/**
 * Feedback categories.
 *
 * A closed set rather than free text so the admin queue can be filtered
 * and counted. Kept as a Zod enum instead of a Postgres enum because
 * adding a category should not require a migration.
 *
 * These values MUST match portal_feedback_category_check in
 * 11_feedback_and_ratings.sql exactly. A value that passes here but fails
 * the constraint would surface as a 500 from the database rather than a
 * 400 from the validator — the reporter would see "something went wrong"
 * on a form that was filled in correctly.
 */
export const FEEDBACK_CATEGORIES = Object.freeze([
  'GENERAL',
  'SUGGESTION',
  'BUG',
  'TECHNICAL',
  'USABILITY',
  'OTHER',
]);

/** Admin-managed lifecycle. Mirrors the SQL CHECK constraint. */
export const FEEDBACK_STATUSES = Object.freeze([
  'NEW',
  'IN_REVIEW',
  'RESOLVED',
  'CLOSED',
]);

/**
 * Trim before length-checking, so "   " is empty rather than 3 characters.
 * Without this, whitespace-only reports pass a `min(1)` and land in the
 * queue as blank rows.
 */
const trimmed = (min, max, label) =>
  z
    .string({ required_error: `${label} is required` })
    .transform((s) => s.trim())
    .refine((s) => s.length >= min, {
      message: `${label} must be at least ${min} characters`,
    })
    .refine((s) => s.length <= max, {
      message: `${label} must be at most ${max} characters`,
    });

export const createFeedbackSchema = z.object({
  category: z.enum(FEEDBACK_CATEGORIES, {
    errorMap: () => ({ message: 'Choose a valid category' }),
  }),

  /**
   * 5 minimum: "bug" is not a report. 150 maximum keeps the admin list
   * scannable on one line.
   */
  subject: trimmed(5, 150, 'Subject'),

  /**
   * 4000 is generous — a good bug report includes steps to reproduce —
   * but bounded, because an unbounded TEXT column is a free way to fill
   * the database.
   */
  description: trimmed(10, 4000, 'Description'),

  /**
   * Cloudinary public_id of an already-uploaded screenshot, not the file
   * itself. Uploads go straight to Cloudinary via the signed-upload flow
   * in uploadRoutes.js, so this endpoint stays a small JSON write and
   * never buffers an image.
   *
   * The character class is the restrictive part: a public_id is only ever
   * folder-ish text, so anything with a slash-dot-slash, a scheme or a
   * space is rejected rather than stored and later interpolated into a
   * URL.
   */
  screenshotPath: z
    .string()
    .max(255)
    .regex(/^[A-Za-z0-9/_-]+$/, 'Invalid screenshot reference')
    .optional()
    .nullable(),

  /**
   * Diagnostic metadata. Optional and capped: useful for reproducing a
   * bug, never trusted, and never rendered as HTML.
   *
   * `pageUrl` is a plain bounded string rather than z.string().url()
   * because a hash route ("/tickets/x#comments") is exactly what we want
   * and is still a valid URL — but a validator that rejects anything
   * unusual would silently drop the most useful field in the report.
   */
  pageUrl: z.string().max(500).optional().nullable(),
  appVersion: z.string().max(50).optional().nullable(),
});

/**
 * Admin update. Every field optional — a moderator may only be changing
 * the status, or only adding a note.
 */
export const updateFeedbackSchema = z
  .object({
    status: z.enum(FEEDBACK_STATUSES).optional(),
    adminNotes: z.string().max(2000).optional().nullable(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

/** Admin list filters. */
export const listFeedbackSchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  category: z.enum(FEEDBACK_CATEGORIES).optional(),
  /**
   * Cursor pagination, matching the comment moderation queue. An
   * offset-based `page` param gets slower the deeper an admin scrolls;
   * a cursor stays constant-time and cannot be used to ask for row
   * 10,000,000.
   */
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// ------------------------------------------------------------
// §10 — portal ratings
// ------------------------------------------------------------

/**
 * A rating submission, or a dismissal.
 *
 * One schema for both because they are the same event from the prompt's
 * point of view: the user answered. `dismissed: true` carries no stars;
 * the DB CHECK enforces that pairing so the two can never disagree.
 */
export const submitRatingSchema = z
  .object({
    stars: z.coerce.number().int().min(1).max(5).optional(),
    reason: z.string().max(1000).optional().nullable(),
    dismissed: z.boolean().default(false),
    appVersion: z.string().max(50).optional().nullable(),
  })
  .refine((data) => data.dismissed || typeof data.stars === 'number', {
    message: 'stars is required unless the prompt was dismissed',
    path: ['stars'],
  })
  .refine((data) => !data.dismissed || data.stars === undefined, {
    message: 'A dismissed prompt cannot carry a star rating',
    path: ['stars'],
  });

/** Admin list filters for ratings. */
export const listRatingsSchema = z.object({
  /**
   * Dismissals are stored as rows but are not opinions, so they are
   * excluded from the admin list by default — otherwise the average and
   * the distribution would both be polluted by non-answers.
   */
  includeDismissed: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  minStars: z.coerce.number().int().min(1).max(5).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
