/**
 * Rate limiting.
 *
 * The old API had none: the 6-digit OTP could be brute-forced in
 * seconds and login was wide open. Writes and auth are now throttled.
 */

import rateLimit from 'express-rate-limit';

const build = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
  });

/** Generic API ceiling. */
export const apiLimiter = build(
  15 * 60 * 1000,
  300,
  'Too many requests. Please try again shortly.'
);

/** Signup / password reset — strict, these create records and send mail. */
export const authLimiter = build(
  15 * 60 * 1000,
  10,
  'Too many authentication attempts. Please try again in 15 minutes.'
);

/** Ticket creation — stops spam floods from a single account. */
export const createTicketLimiter = build(
  60 * 60 * 1000,
  15,
  'You have submitted several tickets recently. Please wait before submitting another.'
);

/** Comments and votes — chatty but cheap. */
export const interactionLimiter = build(
  5 * 60 * 1000,
  60,
  'You are doing that too quickly. Please slow down.'
);
