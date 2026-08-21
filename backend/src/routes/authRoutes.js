/**
 * Authentication routes.
 *
 * Signup runs through this API (rather than straight from the browser
 * to Supabase) specifically so the email-domain policy can be enforced.
 *
 * Login, password reset and session refresh stay on the client via
 * supabase-js — there's no policy to apply and Supabase handles them
 * better than we would.
 */

import express from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { prisma } from '../lib/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter, emailCheckLimiter } from '../middleware/rateLimiter.js';

import { validateBody } from '../middleware/validate.js';
import { checkEmailDomain, isApprovedDomain } from '../services/domainPolicy.js';
import { getSettings } from '../services/settingsService.js';
import { checkSignupAllowed } from '../services/registrationPolicy.js';
import { invalidateUser } from '../services/authCache.js';
import {
  signupSchema,
  updateProfileSchema,
  checkEmailSchema,
} from '../validators/authSchemas.js';

const router = express.Router();

/**
 * POST /api/auth/check-email
 * Lets the signup form warn about a disallowed domain before the
 * user fills in the rest of the form.
 */
router.post(
  '/check-email',
  // Not the strict authLimiter: the signup form calls this while the user
  // is still typing, so a 10/15min budget shared across a campus NAT would
  // break the form for everyone. emailCheckLimiter is still IP-keyed to
  // stop the endpoint being farmed for "which emails are registered".
  emailCheckLimiter,
  validateBody(checkEmailSchema),

  asyncHandler(async (req, res) => {
    const { allowed, reason } = await checkEmailDomain(req.body.email);
    res.json({ allowed, reason: reason ?? null });
  })
);

/**
 * POST /api/auth/signup
 * Creates the auth user. The `on_auth_user_created` trigger creates
 * the matching profile row in the same transaction.
 */
router.post(
  '/signup',
  authLimiter,
  validateBody(signupSchema),
  asyncHandler(async (req, res) => {
    const { email, password, fullName, matricNumber, faculty, department } = req.body;

    // Registration switch. Checked here, before any Supabase work, because
    // this route holds the service-role key and is therefore the only path
    // that can mint an account — the browser cannot create one directly
    // (anon has no INSERT on profiles, see 06_security_hardening.sql).
    //
    // Read fresh: a stale cache entry could keep registration open for up
    // to the cache TTL after an admin closes it, and "closed" is exactly
    // the kind of decision that should take effect immediately.
    //
    // Note this gates account *creation* only. Login, password reset and
    // every existing account are untouched, so closing signups can never
    // lock out current students or staff.
    //
    // Read once and reused for the matric-number rule below: two separate
    // fresh reads could disagree if an admin saved between them, and would
    // double the settings latency on every signup for no benefit.
    const settings = await getSettings({ fresh: true });

    const signup = checkSignupAllowed(settings);
    if (!signup.allowed) throw new ApiError(403, signup.reason);

    const { allowed, reason } = await checkEmailDomain(email);
    if (!allowed) throw new ApiError(403, reason);

    /**
     * Matric number, required only if the admin says so.
     *
     * Checked here rather than in the Zod schema because the requirement
     * is a runtime setting, not a property of the request shape — a schema
     * built at import time cannot know what the admin chose this morning.
     *
     * Ordered before the Supabase Auth call for the same reason as the
     * duplicate check below: rejecting afterwards would leave an orphaned
     * auth user, and the student's corrected second attempt would then be
     * refused with "email already registered".
     */
    if (settings.requireMatricNumber && !matricNumber) {
      throw new ApiError(400, 'A matriculation number is required to register.');
    }

    // Check matric number before creating the auth user, so a duplicate
    // doesn't leave an orphaned account behind.
    if (matricNumber) {
      const clash = await prisma.profile.findUnique({ where: { matricNumber } });
      if (clash) throw new ApiError(409, 'That matric number is already registered.');
    }

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // dev: auto-confirm. Switch off when SMTP is configured.
      user_metadata: {
        full_name: fullName,
        matric_number: matricNumber || null,
        faculty: faculty || null,
      },
    });

    if (error) {
      if (/already registered|already been registered/i.test(error.message)) {
        throw new ApiError(409, 'An account with this email already exists.');
      }
      throw new ApiError(400, error.message);
    }

    // Fill in fields the trigger doesn't cover
    const approved = await isApprovedDomain(email);
    await prisma.profile.update({
      where: { id: data.user.id },
      data: {
        department: department || null,
        emailVerifiedDomain: approved,
      },
    }).catch(() => {}); // trigger already created the row; non-fatal

    res.status(201).json({
      message: 'Account created successfully. You can now sign in.',
      userId: data.user.id,
    });
  })
);

/**
 * GET /api/auth/me
 * Returns the signed-in user's profile — the source of truth for
 * role and identity. Replaces the old hardcoded faculty/matric values.
 */
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ profile: req.user });
  })
);

/**
 * PATCH /api/auth/me
 * Persists profile edits. Previously this only fired an alert().
 */
router.patch(
  '/me',
  requireAuth,
  validateBody(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const { fullName, matricNumber, faculty, department, avatarUrl } = req.body;

    if (matricNumber) {
      const clash = await prisma.profile.findUnique({ where: { matricNumber } });
      if (clash && clash.id !== req.user.id) {
        throw new ApiError(409, 'That matric number is already registered.');
      }
    }

    /*
     * Requirement 6's other half: the three identity fields are mandatory
     * at signup, so this endpoint must not be the way they get emptied
     * again. `matricNumber: ''` would otherwise be written as null below
     * and quietly undo the registration requirement.
     *
     * Scoped to fields that currently *hold* a value. Accounts created
     * before this release have NULLs, and the brief requires they keep
     * working — so a legacy profile may still be saved with them blank
     * (and filling one in is a one-way improvement). What is refused is
     * clearing a value that is already there.
     */
    const clearing = [];
    if (matricNumber !== undefined && !matricNumber) clearing.push('matricNumber');
    if (faculty !== undefined && !faculty) clearing.push('faculty');
    if (department !== undefined && !department) clearing.push('department');

    if (clearing.length) {
      // One read, only when something is actually being blanked.
      const current = await prisma.profile.findUnique({
        where: { id: req.user.id },
        select: { matricNumber: true, faculty: true, department: true },
      });

      const LABELS = {
        matricNumber: 'matric number',
        faculty: 'faculty',
        department: 'department',
      };

      const wouldClear = clearing.filter((f) => current?.[f]);
      if (wouldClear.length) {
        throw new ApiError(
          400,
          `Your ${wouldClear
            .map((f) => LABELS[f])
            .join(', ')} cannot be removed. Update it to a new value instead.`
        );
      }
    }


    const updated = await prisma.profile.update({
      where: { id: req.user.id },
      data: {
        ...(fullName     !== undefined && { fullName }),
        ...(matricNumber !== undefined && { matricNumber: matricNumber || null }),
        ...(faculty      !== undefined && { faculty: faculty || null }),
        ...(department   !== undefined && { department: department || null }),
        ...(avatarUrl    !== undefined && { avatarUrl: avatarUrl || null }),
      },
    });

    // After the write, never before: invalidating first leaves a window in
    // which a concurrent request re-reads and re-caches the *old* row, and
    // the stale copy then outlives the change it was meant to clear.
    //
    // Not a privilege change — role is not editable here, see the field
    // allow-list in updateProfileSchema — but without this the user's own
    // edit would appear not to have saved for a few seconds.
    invalidateUser(req.user.id);

    res.json({ profile: updated, message: 'Profile updated.' });
  })
);

export default router;
