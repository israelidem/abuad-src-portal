/**
 * Central error handling.
 *
 * Fixes the old behaviour of returning raw `error.message` on every
 * route, which leaked database internals and stack details to clients.
 */

import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { logger, securityLog } from '../lib/logger.js';

export const notFoundHandler = (req, _res, next) => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

// eslint-disable-next-line no-unused-vars -- Express requires 4 args
export const errorHandler = (err, req, res, _next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Something went wrong.';
  let details = err.details;

  // --- Prisma: unique constraint violation ---
  //
  // This is the backstop for a genuine race: signup checks the matric
  // number before inserting, but two simultaneous requests can both pass
  // that check and only one can win the UNIQUE index. The loser lands here,
  // so the copy has to be presentable rather than a leaked column name —
  // it previously read "That matric_number is already in use."
  if (err.code === 'P2002') {
    statusCode = 409;
    const target = err.meta?.target;
    const field = Array.isArray(target) ? target[0] : target ?? 'value';

    // Deliberately worded not to confirm *whose* account it is, which
    // would turn this endpoint into an account-enumeration oracle.
    const FRIENDLY = {
      email: 'An account with this email already exists.',
      matric_number: 'This matriculation number is already registered.',
      matricNumber: 'This matriculation number is already registered.',
    };

    message = FRIENDLY[field] ?? `That ${String(field).replace(/_/g, ' ')} is already in use.`;
  }

  // --- Prisma: record not found ---
  if (err.code === 'P2025') {
    statusCode = 404;
    message = 'Record not found.';
  }

  // --- Zod validation ---
  if (err.name === 'ZodError') {
    statusCode = 400;
    message = 'Validation failed.';
    details = err.errors?.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));
  }

  // Never leak internals for unexpected 500s in production
  if (statusCode === 500 && !env.isDev) {
    message = 'An unexpected error occurred. Please try again.';
    details = undefined;
  }

  // `req.log` is bound to the request id by requestContext; fall back to the
  // bare logger so an error thrown before that middleware still gets logged
  // rather than crashing the handler on an undefined.
  const log = req.log ?? logger;

  if (statusCode >= 500) {
    // The full error object goes through the logger's sanitiser, which
    // flattens it and strips anything credential-shaped — Prisma errors in
    // particular can carry a connection string in their message.
    log.error('request.failed', {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: statusCode,
      userId: req.user?.id,
      err,
    });
  } else if (statusCode === 401 || statusCode === 403) {
    // Separated out because these are the lines that answer "is someone
    // probing us?". A handful is normal; a burst from one user is not.
    securityLog(statusCode === 401 ? 'unauthenticated' : 'forbidden', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      userId: req.user?.id,
      reason: err.message,
    });
  }

  res.status(statusCode).json({
    error: message,
    // Gives the user something to quote. Without it, "an unexpected error
    // occurred" is unactionable for both them and whoever reads the logs.
    ...(req.id ? { requestId: req.id } : {}),
    ...(details ? { details } : {}),
    ...(env.isDev && statusCode >= 500 ? { stack: err.stack } : {}),
  });
};

/** Wraps async route handlers so rejections reach the error handler. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
