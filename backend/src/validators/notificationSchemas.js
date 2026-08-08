import { z } from 'zod';

/**
 * The shape the browser's PushSubscription.toJSON() produces. Keys are
 * base64url and their exact length is UA-specific, so they're validated
 * as non-empty strings rather than by size.
 */
export const pushSubscribeSchema = z.object({
  endpoint: z.string().url('A valid push endpoint is required.'),
  keys: z.object({
    p256dh: z.string().min(1, 'Missing p256dh key.'),
    auth: z.string().min(1, 'Missing auth key.'),
  }),
});

export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url('A valid push endpoint is required.'),
});

export const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
