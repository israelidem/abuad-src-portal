/**
 * Request correlation and access logging.
 *
 * The gap this closes: when a student said "it failed", there was no way to
 * find their request. Errors were logged with a method and URL, which every
 * concurrent request shares, and nothing tied the 500 to the user, the
 * timing, or the other lines emitted while handling it.
 *
 * Now each request gets an id, that id is attached to `req` (so the error
 * handler and any route can quote it), returned to the client in
 * `X-Request-Id`, and included in the completion line. A student can read
 * the id off an error toast and it leads straight to the log entry.
 *
 * Two things this deliberately does *not* do:
 *
 *   - **No request bodies.** They contain ticket text, matric numbers and
 *     credentials. The method, path, status and duration answer the
 *     operational questions without turning the log into a data export.
 *
 *   - **No AsyncLocalStorage.** It would remove the need to thread `req`
 *     through to a logger, but it carries a real cost under load and the
 *     handlers here already have `req`. Not worth the overhead for the
 *     convenience.
 */

import { randomUUID } from 'node:crypto';

import { logger } from '../lib/logger.js';

/**
 * Paths that would otherwise dominate the log.
 *
 * `/health` is hit by the keep-alive workflow every few minutes, forever.
 * Logging it buries real traffic and, on a metered log drain, costs money
 * to store. Failures still surface: the handler's own 503 path is logged.
 */
const QUIET_PATHS = new Set(['/health', '/']);

/** Anything at or above this is worth knowing about even when it succeeds. */
const SLOW_MS = 1_000;

export const requestContext = (req, res, next) => {
  // Honour an upstream id if the proxy set one, so a trace spanning the
  // CDN and the API shares a single identifier. Length-capped because it
  // arrives from the client and ends up in a response header.
  const inbound = req.get('x-request-id');
  req.id = inbound && inbound.length <= 64 ? inbound : randomUUID();

  // Let the client quote the id when reporting a problem.
  res.setHeader('X-Request-Id', req.id);

  // Pre-bound so route code never has to remember to include the id.
  req.log = logger.child({ requestId: req.id });

  const startedAt = process.hrtime.bigint();

  // 'finish' rather than 'close': it fires once the response is fully
  // written, which is when the status and duration are actually final.
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    const quiet = QUIET_PATHS.has(req.path) && res.statusCode < 400;
    const slow = durationMs >= SLOW_MS;
    if (quiet && !slow) return;

    // Server errors are already logged in detail by the error handler; this
    // line is the access record, so it stays at warn to avoid double-
    // counting an error that has its own entry.
    const level = res.statusCode >= 500 ? 'warn' : res.statusCode >= 400 ? 'info' : 'info';

    req.log[level]('request.complete', {
      method: req.method,
      // `req.route?.path` would give the pattern rather than the resolved
      // URL, but it's unset for 404s — the exact case where the path
      // matters most. originalUrl minus the query string keeps ticket ids
      // in (useful) and search terms out (private).
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs),
      // Present only once auth middleware has run, which is the point:
      // an unauthenticated 401 legitimately has no user.
      userId: req.user?.id,
      role: req.user?.role,
      ...(slow ? { slow: true } : {}),
    });
  });

  next();
};
