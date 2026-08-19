/**
 * Authentication & authorisation middleware.
 *
 * This is the fix for the single biggest flaw in the old codebase:
 * every route was public, and "admin mode" was a React useState.
 * Roles now come from the database and are verified on every request.
 */

import { supabaseAdmin } from '../lib/supabase.js';
import { prisma } from '../lib/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { getCachedSession, cacheSession } from '../services/authCache.js';

/**
 * Resolves a bearer token to a profile.
 *
 * Both steps are remote calls — token verification is HTTPS to Supabase
 * Auth (~200ms) and the profile lookup is SQL (~600ms from Lagos, measured
 * with scripts/measure-latency.mjs). Paid on every request, that dominated
 * response time for pages that make several calls, which is why the result
 * is cached for a few seconds. See services/authCache.js for why that is
 * safe and what invalidates it.
 *
 * Only successful resolutions are cached. Failures fall through to the full
 * check every time, so this can never make a bad token look valid.
 */
const resolveSession = async (token) => {
  const cached = getCachedSession(token);
  if (cached) return cached;

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) throw new ApiError(401, 'Invalid or expired session.');

  const profile = await prisma.profile.findUnique({
    where: { id: data.user.id },
  });

  if (!profile) throw new ApiError(401, 'Profile not found.');

  // Checked before caching so a deactivated account is never stored, and
  // after the lookup so the message stays specific.
  if (!profile.isActive) throw new ApiError(403, 'This account has been deactivated.');

  cacheSession(token, profile, data.user);
  return { profile, authUser: data.user };
};

/**
 * Verifies the Supabase JWT and attaches `req.user` (the profile row).
 * Rejects deactivated accounts.
 */
export const requireAuth = async (req, _res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) throw new ApiError(401, 'Authentication required.');

    const { profile, authUser } = await resolveSession(token);

    req.user = profile;
    req.authUser = authUser;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Restricts a route to specific roles.
 * Usage: router.patch('/:id', requireAuth, requireRole('REP', 'ADMIN'), handler)
 */
export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, 'Authentication required.'));
    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, 'You do not have permission to perform this action.'));
    }
    next();
  };

// SUPER_ADMIN is included everywhere ADMIN is. It outranks ADMIN, so
// omitting it would leave the highest role with fewer permissions than
// the one below it.
export const requireStaff = requireRole('REP', 'ADMIN', 'SUPER_ADMIN');
export const requireAdmin = requireRole('ADMIN', 'SUPER_ADMIN');
export const requireSuperAdmin = requireRole('SUPER_ADMIN');

/**
 * Attaches `req.user` when a valid token is present, but never rejects.
 * Used by public endpoints that show extra data to signed-in users
 * (e.g. the public issue board showing "you voted").
 */
export const optionalAuth = async (req, _res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return next();

    // Shares the cache with requireAuth: the public board and the
    // authenticated pages send the same token, so one page load resolves
    // the session once regardless of which middleware runs.
    const { profile, authUser } = await resolveSession(token);

    req.user = profile;
    req.authUser = authUser;
    next();
  } catch {
    next(); // never block a public route on auth failure
  }
};
