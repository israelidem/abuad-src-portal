/**
 * Central error handling.
 *
 * Fixes the old behaviour of returning raw `error.message` on every
 * route, which leaked database internals and stack details to clients.
 */

import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

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

  if (statusCode >= 500) {
    console.error('[ERROR]', req.method, req.originalUrl, '\n', err);
  }

  res.status(statusCode).json({
    error: message,
    ...(details ? { details } : {}),
    ...(env.isDev && statusCode >= 500 ? { stack: err.stack } : {}),
  });
};

/** Wraps async route handlers so rejections reach the error handler. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
