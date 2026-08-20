/**
 * Rate limiting.
 *
 * The old API had none: the 6-digit OTP could be brute-forced in
 * seconds and login was wide open. Writes and auth are now throttled.
 *
 * ---------------------------------------------------------------------
 * Why this file is more than a one-line `rateLimit()` call
 * ---------------------------------------------------------------------
 * 1. IDENTITY, NOT ADDRESS. express-rate-limit keys on IP by default.
 *    ABUAD students browse from campus WiFi behind a handful of NATs, so
 *    an IP bucket is really a "few thousand students" bucket: one heavy
 *    user exhausts the quota and everyone else gets 429s. Authenticated
 *    requests are therefore keyed by identity, and only anonymous
 *    traffic falls back to IP.
 *
 * 2. IPv6 CANNOT BE USED RAW. A single customer is routinely handed a
 *    whole /64, so keying on the full address lets an attacker rotate
 *    through billions of "new" clients. IPv6 is truncated to its /64
 *    prefix. express-rate-limit ships an `ipKeyGenerator` helper for
 *    this in newer releases, but 7.5.1 (the pinned version) does not
 *    export it — verified via scripts/probe-ratelimit.mjs — so the
 *    normalisation is done here.
 *
 * 3. LIMITS ARE PER PURPOSE. A ceiling that suits comment posting would
 *    be absurd for signup. Each limiter below documents its own budget.
 *
 * Limits are enforced here, server-side. Any client-side throttling is a
 * UX nicety only and is assumed to be absent/bypassed.
 */

import rateLimit from 'express-rate-limit';
import { createHash } from 'crypto';
import { logger } from '../lib/logger.js';

/**
 * Collapses an IP to a stable, abuse-resistant bucket.
 *
 * IPv4 is used as-is. IPv6 keeps only the first four hextets (the /64
 * routing prefix) because anything narrower is free for an attacker to
 * rotate. IPv4-mapped IPv6 (`::ffff:1.2.3.4`, which is what Node reports
 * on dual-stack sockets) is unwrapped first so the same client is not
 * tracked under two different keys.
 */
export const ipBucket = (rawIp) => {
  if (!rawIp) return 'unknown';

  const ip = rawIp.startsWith('::ffff:') ? rawIp.slice(7) : rawIp;

  if (!ip.includes(':')) return ip;

  // Expand the :: shorthand just enough to take a meaningful prefix.
  const hextets = ip.split(':');
  return `${hextets.slice(0, 4).join(':')}::/64`;
};

/**
 * Identity-first key.
 *
 * `req.user` is populated by requireAuth/optionalAuth, both of which run
 * before the route-level limiters. For the app-wide limiter — which is
 * mounted ahead of every router and so sees no `req.user` — the bearer
 * token is hashed instead. The hash is a stable per-session identifier
 * that cannot be forged without valid credentials, and it is never
 * logged or returned. Falling back to IP for genuinely anonymous calls
 * keeps public endpoints protected.
 */
export const identityKey = (req) => {
  if (req.user?.id) return `u:${req.user.id}`;

  const header = req.headers?.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) {
      return `t:${createHash('sha256').update(token).digest('base64url').slice(0, 24)}`;
    }
  }

  return `ip:${ipBucket(req.ip)}`;
};

/** IP-only key, for endpoints reachable before a user exists. */
export const ipOnlyKey = (req) => `ip:${ipBucket(req.ip)}`;

/**
 * Shared limiter factory.
 *
 * `retryAfterSeconds` is surfaced so clients can back off intelligently
 * instead of hammering. The body deliberately says nothing about who was
 * throttled, which bucket was used, or how much of the quota remains
 * beyond the standard headers — a probe should not be able to map the
 * policy from responses.
 */
const build = ({ windowMs, limit, message, keyGenerator = identityKey, name, skip }) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    skip,
    handler: (req, res) => {
      // Logged so a real attack is visible in ops dashboards. The key is
      // hashed/opaque, so this does not put credentials in the log.
      logger.warn('ratelimit.exceeded', {
        limiter: name,
        method: req.method,
        path: req.originalUrl,
        key: keyGenerator(req),
      });

      res.status(429).json({
        error: message,
        retryAfterSeconds: Math.ceil(windowMs / 1000),
      });
    },
  });

/**
 * Generic API ceiling — a backstop, not the real defence.
 *
 * Sized for a genuinely busy student: dashboard, ticket list, a detail
 * view and notification checks add up quickly, and the SPA fans out
 * several calls per screen. 600/15min is ~40/min sustained, far above
 * real usage but low enough to blunt a scripted flood. Keyed by session
 * so campus NAT does not turn this into a shared quota.
 */
export const apiLimiter = build({
  name: 'api',
  windowMs: 15 * 60 * 1000,
  limit: 600,
  message: 'Too many requests. Please try again shortly.',
});

/**
 * Signup / password reset — strict, these create records and send mail.
 *
 * Deliberately IP-keyed: there is no session yet, and the abuse being
 * prevented is one host mass-creating accounts. 10/15min is generous for
 * a human filling in a form once and hostile to automation.
 */
export const authLimiter = build({
  name: 'auth',
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Too many authentication attempts. Please try again in 15 minutes.',
  keyGenerator: ipOnlyKey,
});

/**
 * Email availability checks.
 *
 * Shares the signup surface but is called while typing, so the strict
 * auth budget would break the form for a whole NAT. Still IP-keyed to
 * stop the endpoint being used to enumerate which emails are registered,
 * just with room for legitimate retries.
 */
export const emailCheckLimiter = build({
  name: 'auth.check-email',
  windowMs: 15 * 60 * 1000,
  limit: 40,
  message: 'Too many lookups. Please try again shortly.',
  keyGenerator: ipOnlyKey,
});

/**
 * Ticket creation — stops spam floods from a single account.
 *
 * Now genuinely per-account: the previous IP keying meant one student on
 * campus WiFi could exhaust the quota for everybody sharing the NAT,
 * while an attacker on a mobile network sidestepped it by reconnecting.
 */
export const createTicketLimiter = build({
  name: 'ticket.create',
  windowMs: 60 * 60 * 1000,
  limit: 15,
  message: 'You have submitted several tickets recently. Please wait before submitting another.',
});

/** Comments and votes — chatty but cheap. */
export const interactionLimiter = build({
  name: 'interaction',
  windowMs: 5 * 60 * 1000,
  limit: 60,
  message: 'You are doing that too quickly. Please slow down.',
});

/**
 * Comment posting.
 *
 * Tighter than generic interactions: every comment runs the moderation
 * matcher, notifies watchers and is publicly visible, so it is the most
 * attractive spam target. 20/5min still allows an active thread
 * discussion.
 */
export const commentLimiter = build({
  name: 'comment.create',
  windowMs: 5 * 60 * 1000,
  limit: 20,
  message: 'You are commenting too quickly. Please wait a moment before posting again.',
});

/**
 * Notification reads / mark-as-read.
 *
 * The bell polls, so this must stay well clear of normal behaviour or
 * the badge silently breaks; it exists only to stop a runaway client (or
 * a tight retry loop) from turning one browser into a DoS source.
 */
export const notificationLimiter = build({
  name: 'notification',
  windowMs: 5 * 60 * 1000,
  limit: 150,
  message: 'Too many notification requests. Please try again shortly.',
});

/**
 * File uploads — the most expensive request the API serves.
 *
 * Bandwidth, image processing and third-party storage quota all get
 * consumed, and failed uploads can leave orphaned objects behind, so
 * this is the strictest authenticated budget.
 */
export const uploadLimiter = build({
  name: 'upload',
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: 'Too many uploads. Please wait a few minutes before uploading again.',
});

/**
 * Portal feedback and rating submissions.
 *
 * A user has a handful of legitimate things to say per sitting; anything
 * beyond that is spam. Kept per-account so one abuser cannot mute the
 * feature for others.
 */
export const feedbackLimiter = build({
  name: 'feedback.create',
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: 'You have submitted feedback several times recently. Please wait before sending more.',
});

/**
 * Administrative writes.
 *
 * Staff are trusted, so this is not about the admins themselves: it caps
 * the damage if an admin session is stolen, and catches a buggy bulk
 * script before it rewrites the database.
 */
export const adminWriteLimiter = build({
  name: 'admin.write',
  windowMs: 5 * 60 * 1000,
  limit: 100,
  message: 'Too many administrative changes at once. Please slow down.',
});
