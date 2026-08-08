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

const { publicKey, privateKey, subject } = env.vapid;

export const pushEnabled = Boolean(publicKey && privateKey);

if (pushEnabled) {
  webpush.setVapidDetails(subject, publicKey, privateKey);
} else {
  console.warn('[push] VAPID keys not set — push notifications are disabled.');
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
          console.warn(`[push] delivery failed (${error.statusCode ?? '?'}):`, error.message);
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

  const notification = await prisma.notification.create({
    data: { userId, type, title, body, link },
  });

  // Not awaited into the caller's critical path
  sendToUser(userId, { title, body, link, tag }).catch(() => {});

  return notification;
}
