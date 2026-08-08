/**
 * Notification routes — the in-app bell plus Web Push registration.
 *
 * Every handler is scoped to req.user.id. A notification belongs to
 * exactly one person, so there is no "look it up then check ownership"
 * step: ownership is part of the query.
 */

import express from 'express';

import { prisma } from '../lib/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { env } from '../config/env.js';
import { pushEnabled } from '../services/pushService.js';
import {
  pushSubscribeSchema,
  pushUnsubscribeSchema,
  listNotificationsQuerySchema,
} from '../validators/notificationSchemas.js';

const router = express.Router();

/**
 * GET /api/notifications/vapid-public-key
 * The client needs this to call pushManager.subscribe(). It's a public
 * key by design — safe to hand out, and only to signed-in users anyway.
 */
router.get(
  '/vapid-public-key',
  asyncHandler(async (_req, res) => {
    res.json({ publicKey: env.vapid.publicKey ?? null, enabled: pushEnabled });
  })
);

/** GET /api/notifications — the bell dropdown. */
router.get(
  '/',
  requireAuth,
  validateQuery(listNotificationsQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, limit, unreadOnly } = req.query;
    const where = { userId: req.user.id, ...(unreadOnly ? { isRead: false } : {}) };
    const skip = (page - 1) * limit;

    const [total, unreadCount, notifications] = await Promise.all([
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId: req.user.id, isRead: false } }),
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    res.json({
      notifications,
      unreadCount,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
        hasNext: skip + notifications.length < total,
        hasPrev: page > 1,
      },
    });
  })
);

/** PATCH /api/notifications/read-all — clears the badge in one call. */
router.patch(
  '/read-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { count } = await prisma.notification.updateMany({
      where: { userId: req.user.id, isRead: false },
      data: { isRead: true },
    });

    res.json({ message: 'All notifications marked as read.', count });
  })
);

/** PATCH /api/notifications/:id/read */
router.patch(
  '/:id/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    // userId in the where clause means another user's ID simply matches
    // nothing — no separate ownership check, and no way to probe for the
    // existence of someone else's notification.
    const { count } = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user.id },
      data: { isRead: true },
    });

    if (!count) throw new ApiError(404, 'Notification not found.');

    res.json({ message: 'Marked as read.' });
  })
);

// ------------------------------------------------------------
// Web Push subscriptions
// ------------------------------------------------------------

/**
 * POST /api/notifications/subscribe
 *
 * Upsert on endpoint: browsers hand back the same endpoint for the same
 * device, and re-subscribing (new install, refreshed permission) must not
 * accumulate duplicate rows that each fire their own notification.
 */
router.post(
  '/subscribe',
  requireAuth,
  validateBody(pushSubscribeSchema),
  asyncHandler(async (req, res) => {
    if (!pushEnabled) {
      throw new ApiError(503, 'Push notifications are not configured on this server.');
    }

    const { endpoint, keys } = req.body;

    const subscription = await prisma.pushSubscription.upsert({
      where: { endpoint },
      // A shared device can pass the same endpoint to a different account,
      // so userId is refreshed on conflict — otherwise the previous owner
      // would keep receiving this browser's notifications.
      update: {
        userId: req.user.id,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: req.get('user-agent') ?? null,
      },
      create: {
        userId: req.user.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: req.get('user-agent') ?? null,
      },
    });

    res.status(201).json({ message: 'Subscribed.', id: subscription.id });
  })
);

/** DELETE /api/notifications/subscribe — turn push off for this device. */
router.delete(
  '/subscribe',
  requireAuth,
  validateBody(pushUnsubscribeSchema),
  asyncHandler(async (req, res) => {
    await prisma.pushSubscription.deleteMany({
      where: { endpoint: req.body.endpoint, userId: req.user.id },
    });

    // Idempotent: unsubscribing something already gone is still success.
    res.json({ message: 'Unsubscribed.' });
  })
);

export default router;
