/**
 * Ticket request validation.
 *
 * Enums mirror schema.prisma exactly — Zod rejects anything else before
 * it can reach Prisma, so a bad value returns 400 rather than 500.
 */

import { z } from 'zod';

export const TICKET_CATEGORIES = [
  'ACADEMIC',
  'ICT',
  'INFRASTRUCTURE',
  'WELFARE',
  'ADMINISTRATION',
  'OTHER',
];

export const TICKET_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'RESOLVED',
  'CLOSED',
  'REOPENED',
];

export const URGENCIES = ['LOW', 'MEDIUM', 'HIGH'];

const uuid = z.string().uuid('Must be a valid ID.');

export const ticketIdParamSchema = z.object({
  id: uuid,
});

export const createTicketSchema = z.object({
  faculty: z
    .string()
    .trim()
    .min(2, 'Faculty is required.')
    .max(120, 'Faculty name is too long.'),

  /**
   * Optional as of Phase 5. Students used to answer two near-identical
   * questions — "category" and "which department?" — so the form now
   * asks only for the department and the API derives the category from
   * it. Still accepted directly for older clients and for staff, who do
   * think in categories; see the refine below for the "at least one"
   * rule.
   */
  category: z
    .enum(TICKET_CATEGORIES, {
      errorMap: () => ({ message: `Category must be one of: ${TICKET_CATEGORIES.join(', ')}` }),
    })
    .optional(),

  description: z
    .string()
    .trim()
    .min(20, 'Please describe the issue in at least 20 characters.')
    .max(5000, 'Description cannot exceed 5000 characters.'),

  urgency: z.enum(URGENCIES).default('MEDIUM'),

  locationText: z
    .string()
    .trim()
    .min(2, 'Location is required.')
    .max(255, 'Location is too long.'),

  locationLat: z.number().min(-90).max(90).optional(),
  locationLng: z.number().min(-180).max(180).optional(),

  departmentId: uuid.optional(),

  isAnonymous: z.boolean().default(false),

  /// Hidden from the public board — visible to the author and staff only.
  isPublic: z.boolean().default(true),

  /// Storage paths from a completed Supabase Storage upload.
  /// The file itself never passes through this API.
  attachments: z
    .array(
      z.object({
        storagePath: z.string().min(1).max(500),
        thumbPath: z.string().max(500).optional(),
        mimeType: z
          .string()
          .regex(/^image\/(jpeg|jpg|png|webp|gif)$/, 'Only image attachments are supported.'),
        sizeBytes: z
          .number()
          .int()
          .positive()
          .max(10 * 1024 * 1024, 'Attachments must be under 10MB.'),
      })
    )
    .max(5, 'A maximum of 5 attachments is allowed.')
    .optional(),
})
  // One of the two must be present. The service prefers `departmentId`
  // and derives the category from it; an explicit `category` with no
  // department still works for older clients.
  .refine((data) => Boolean(data.category || data.departmentId), {
    message: 'Choose which department should handle this.',
    path: ['departmentId'],
  });

/**
 * Students may correct details, but only while the ticket is still PENDING.
 *
 * `departmentId` is here because staff re-route tickets through this same
 * endpoint. Zod strips unknown keys, so omitting it didn't reject the
 * request — it silently emptied the body, which then failed the
 * "no changes supplied" guard below with an unhelpful `Validation failed.`
 * The route re-checks that only staff may set it.
 */
export const updateTicketSchema = z
  .object({
    description: z.string().trim().min(20).max(5000).optional(),
    urgency: z.enum(URGENCIES).optional(),
    locationText: z.string().trim().min(2).max(255).optional(),
    category: z.enum(TICKET_CATEGORIES).optional(),
    isPublic: z.boolean().optional(),
    isAnonymous: z.boolean().optional(),

    /// null clears the routing
    departmentId: uuid.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'No changes supplied.',
  });

/**
 * Staff-only workflow transitions.
 *
 * `departmentId` rides along so "change status and re-route" is a single
 * atomic request. Sending them separately meant a failure on the second
 * left the first already applied — the ticket moved but the UI reported
 * an error and rolled its own select back, so screen and database
 * disagreed.
 */
export const updateTicketStatusSchema = z.object({
  status: z.enum(TICKET_STATUSES),
  /// Surfaced on the public timeline, so it's optional but encouraged.
  note: z.string().trim().max(1000).optional(),
  departmentId: uuid.nullable().optional(),
});

export const assignTicketSchema = z.object({
  /// null clears the assignment
  assignedToId: uuid.nullable(),
});

export const flagTicketSchema = z.object({
  isFlagged: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

export const createCommentSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Comment cannot be empty.')
    .max(2000, 'Comment cannot exceed 2000 characters.'),
  /// Ignored for students — enforced server-side, never trusted from input.
  isInternal: z.boolean().default(false),
});

export const updateCommentSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

export const rateTicketSchema = z.object({
  stars: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
});

/**
 * Query string for listing tickets.
 *
 * Everything arrives as a string, so numbers and booleans are coerced.
 * `sort` is a fixed allowlist mapped to Prisma orderBy in the service —
 * user input never reaches the query builder directly.
 */
export const listTicketsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),

  status: z.enum(TICKET_STATUSES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  urgency: z.enum(URGENCIES).optional(),
  departmentId: uuid.optional(),
  assignedToId: uuid.optional(),
  faculty: z.string().trim().max(120).optional(),

  /// Free-text search across description, location and ticket number
  q: z.string().trim().max(200).optional(),

  /// "mine" — only the caller's tickets; "assigned" — staff's queue
  scope: z.enum(['all', 'mine', 'assigned']).default('all'),

  /**
   * Accepted as an alias for `scope=mine`.
   *
   * The dashboard has always sent `?mine=true`. Zod strips unknown keys,
   * so that param was silently discarded and `scope` fell back to 'all' —
   * meaning "My reports" actually listed the whole public board. Honouring
   * the alias fixes existing callers without needing a coordinated deploy.
   */
  mine: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .optional(),

  /**
   * Past the SLA due date and still unresolved.
   *
   * Same story as `mine`: the admin dashboard sends `?overdue=true` to
   * build its "needs attention" queue, the param was dropped, and the
   * queue was really just "oldest tickets, resolved ones included".
   */
  overdue: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .optional(),

  sort: z
    .enum(['newest', 'oldest', 'most_voted', 'most_discussed', 'due_soon', 'urgency'])
    .default('newest'),

  /**
   * Staff-only: whether tickets hidden from the public board are included.
   *
   * Defaults to *undefined*, not false. This used to default to false,
   * which meant every staff query silently appended `isPublic: true` —
   * so private submissions were invisible on the admin dashboard, in
   * department queues and in search. An admin who was never told the
   * report existed cannot action it, which defeated the feature.
   *
   * Now: staff see everything unless they explicitly pass
   * `includePrivate=false` to narrow the view to the public board.
   * Students are unaffected — their visibility is decided by ownership
   * in buildWhere and never by this flag.
   */
  includePrivate: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .optional(),
});

/**
 * Satisfaction rating. The 1–5 bound is enforced here and again by a
 * CHECK constraint in SQL — the API is not the only path into the table.
 */
export const createRatingSchema = z.object({
  score: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(500).optional(),
});

/**
 * Reopening requires a reason. Without one, staff get a ticket back on
 * their queue with no idea what is still broken.
 */
export const reopenTicketSchema = z.object({
  reason: z.string().trim().min(5, 'Tell us what is still wrong.').max(500),
});
