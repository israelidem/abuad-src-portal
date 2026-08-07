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

  category: z.enum(TICKET_CATEGORIES, {
    errorMap: () => ({ message: `Category must be one of: ${TICKET_CATEGORIES.join(', ')}` }),
  }),

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
});

/** Students may correct details, but only while the ticket is still PENDING. */
export const updateTicketSchema = z
  .object({
    description: z.string().trim().min(20).max(5000).optional(),
    urgency: z.enum(URGENCIES).optional(),
    locationText: z.string().trim().min(2).max(255).optional(),
    category: z.enum(TICKET_CATEGORIES).optional(),
    isPublic: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'No changes supplied.',
  });

/** Staff-only workflow transitions. */
export const updateTicketStatusSchema = z.object({
  status: z.enum(TICKET_STATUSES),
  /// Surfaced on the public timeline, so it's optional but encouraged.
  note: z.string().trim().max(1000).optional(),
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

  sort: z
    .enum(['newest', 'oldest', 'most_voted', 'most_discussed', 'due_soon', 'urgency'])
    .default('newest'),

  /// Staff-only: include tickets hidden from the public board
  includePrivate: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .default(false),
});
