/**
 * Operational error with an HTTP status code.
 *
 * Errors created with this class are "expected" (bad input, forbidden,
 * not found) and their messages are safe to show the client.
 * Anything else is treated as a bug and its details are hidden in
 * production — see middleware/errorHandler.js.
 */
export class ApiError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(msg, details)  { return new ApiError(400, msg, details); }
  static unauthorized(msg = 'Authentication required.') { return new ApiError(401, msg); }
  static forbidden(msg = 'Forbidden.')                  { return new ApiError(403, msg); }
  static notFound(msg = 'Resource not found.')          { return new ApiError(404, msg); }
  static conflict(msg)                                  { return new ApiError(409, msg); }
}
