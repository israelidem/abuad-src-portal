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
import { authLimiter } from '../middleware/rateLimiter.js';
import { validateBody } from '../middleware/validate.js';
import { checkEmailDomain, isApprovedDomain } from '../services/domainPolicy.js';
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
  authLimiter,
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

    const { allowed, reason } = await checkEmailDomain(email);
    if (!allowed) throw new ApiError(403, reason);

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
    res.json({ user: req.user });
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

    res.json({ user: updated, message: 'Profile updated.' });
  })
);

export default router;
