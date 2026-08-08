/**
 * Maintenance mode.
 *
 * Blocks student writes while letting staff work and leaving reads open.
 * A read-only portal during a migration is far more useful than a wall —
 * students can still look up a ticket, they just can't file a new one.
 *
 * Mounted before the routers, so it covers every mutating endpoint
 * without each one having to remember the check.
 */

import { getSettings } from '../services/settingsService.js';
import { optionalAuth } from './auth.js';

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Staff need to keep working during maintenance — that's the point of it. */
const EXEMPT_ROLES = new Set(['REP', 'ADMIN', 'SUPER_ADMIN']);

/**
 * Paths that must keep working even for students, or maintenance mode
 * becomes a lockout: without these, a signed-out student can't sign in to
 * read anything, and a super admin can't reach the toggle to turn it off.
 */
const ALWAYS_ALLOWED = [/^\/api\/auth\//, /^\/api\/admin\/settings/];

export const maintenanceGuard = async (req, res, next) => {
  if (!WRITE_METHODS.has(req.method)) return next();
  if (ALWAYS_ALLOWED.some((pattern) => pattern.test(req.path))) return next();

  try {
    const { maintenanceMode, maintenanceMessage } = await getSettings();
    if (!maintenanceMode) return next();

    // This guard is mounted ahead of the routers, so requireAuth hasn't
    // run yet and req.user is empty. Resolve the role here instead —
    // but only now that maintenance is confirmed on, so the extra token
    // lookup isn't paid on every write during normal operation.
    // optionalAuth never rejects; it just leaves req.user unset.
    if (!req.user) {
      await new Promise((resolve) => optionalAuth(req, res, resolve));
    }

    if (req.user && EXEMPT_ROLES.has(req.user.role)) return next();

    return res.status(503).json({
      error:
        maintenanceMessage ||
        'The portal is briefly down for maintenance. You can still read existing reports — please try again shortly.',
      maintenanceMode: true,
    });
  } catch {
    // Never let a settings failure block writes.
    next();
  }
};
