/**
 * Web Push delivery.
 *
 * VAPID keys are optional config. When they're absent the whole feature
 * degrades to a no-op rather than throwing — a campus portal that can't
 * accept a ticket because notifications aren't configured would be a bad
 * trade, and local dev shouldn't need keys at all.
 *
 * Generate a pair with:  npx web-push generate-vapid-keys
 */

import webpush from 'web-push';

import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

const { publicKey, privateKey, subject } = env.vapid;

export const pushEnabled = Boolean(publicKey && privateKey);

if (pushEnabled) {
  webpush.setVapidDetails(subject, publicKey, privateKey);
} else {
  // Worth a warning rather than silence: "push doesn't work" is one of the
  // reported symptoms, and unset keys is the first thing to rule out. The
  // keys themselves are never logged — only whether they're present.
  logger.warn('push.disabled', { reason: 'VAPID keys not configured' });
}

/**
 * Sends a notification to every device a user has registered.
 *
 * Failures are swallowed by design: this is called from inside request
 * handlers, and a dead browser endpoint must not turn a successful status
 * change into a 500 for the rep who made it.
 *
 * 404/410 mean the subscription is permanently gone (uninstalled PWA,
 * cleared site data). Those rows are deleted so the table doesn't grow
 * unbounded with endpoints that can never receive again.
 */
export async function sendToUser(userId, payload) {
  if (!pushEnabled || !userId) return { sent: 0, failed: 0 };

  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  if (!subscriptions.length) return { sent: 0, failed: 0 };

  const body = JSON.stringify(payload);
  const expired = [];
  let sent = 0;
  let failed = 0;

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body
        );
        sent += 1;
      } catch (error) {
        failed += 1;
        if (error.statusCode === 404 || error.statusCode === 410) {
          expired.push(sub.id);
        } else {
          // Logged against the subscription's row id, not its endpoint: the
          // endpoint is a capability URL for that device and does not
          // belong in a log file. The id is enough to find the row.
          logger.warn('push.delivery_failed', {
            subscriptionId: sub.id,
            userId,
            statusCode: error.statusCode ?? null,
            reason: error.message,
          });
        }
      }
    })
  );

  if (expired.length) {
    await prisma.pushSubscription
      .deleteMany({ where: { id: { in: expired } } })
      .catch(() => {});
  }

  return { sent, failed };
}

/**
 * Writes the in-app notification row and fires a push for it.
 *
 * The bell icon is the source of truth — push is best-effort on top, so
 * the record is created first and a push failure never loses it.
 */
export async function notify(userId, { type, title, body, link, tag }) {
  if (!userId) return null;

  let notification;
  try {
    notification = await prisma.notification.create({
      data: { userId, type, title, body, link },
    });
  } catch (error) {
    // This is the failure that produced "notifications don't appear": the
    // bell reads from this table, so if the insert fails there is nothing
    // to show and — previously — nothing in the logs either, because the
    // throw propagated into a caller that had already swallowed it.
    //
    // Returning null keeps the ticket action succeeding (a reply must not
    // fail because its notification didn't write) while leaving evidence.
    logger.error('notification.create_failed', { userId, type, err: error });
    return null;
  }

  // Not awaited into the caller's critical path. The catch logs rather
  // than discarding: `.catch(() => {})` here meant a total push outage
  // looked identical to push working correctly.
  sendToUser(userId, { title, body, link, tag }).catch((error) => {
    logger.warn('push.send_failed', { userId, notificationId: notification.id, err: error });
  });

  return notification;
}

/** How many users get pushed to at once. */
const PUSH_CHUNK = 50;

/**
 * Same as `notify`, but for a broadcast to many users at once.
 *
 * Calling `notify` in a loop would issue one INSERT per student and open
 * as many concurrent push connections as there are recipients — enough to
 * stall the request on a campus-sized audience. Here the rows go in with
 * a single `createMany`, and pushes fan out in fixed-size chunks.
 *
 * Returns once the rows are written. Push delivery continues in the
 * background: the bell is the source of truth, so a push that fails (or
 * a student with no subscription) must never fail the caller.
 */
export async function notifyMany(userIds, { type, title, body, link, tag }) {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return { created: 0 };

  const { count } = await prisma.notification.createMany({
    data: unique.map((userId) => ({ userId, type, title, body, link })),
  });

  // Deliberately not awaited — see the note above.
  (async () => {
    for (let i = 0; i < unique.length; i += PUSH_CHUNK) {
      const chunk = unique.slice(i, i + PUSH_CHUNK);
      await Promise.allSettled(chunk.map((id) => sendToUser(id, { title, body, link, tag })));
    }
  })().catch((error) => {
    // Records the scale alongside the failure: "broadcast failed" for 3
    // students and for 3,000 are very different incidents, and the old
    // message couldn't tell them apart.
    logger.warn('push.broadcast_failed', { recipients: unique.length, type, err: error });
  });

  return { created: count };
}


