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
  if (err.code === 'P2002') {
    statusCode = 409;
    const field = err.meta?.target?.[0] ?? 'value';
    message = `That ${field} is already in use.`;
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
