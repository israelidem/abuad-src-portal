import { z } from 'zod';

/**
 * Matric numbers are compared for uniqueness, so they must be stored in a
 * single canonical form. Students type them inconsistently — "csc/19/1234",
 * "CSC/19/1234", "CSC / 19 / 1234" — and without normalisation each of
 * those is a distinct value to a UNIQUE index, so the same student could
 * hold several accounts and the duplicate check would never fire.
 *
 * Uppercased (the printed convention on ID cards), internal whitespace
 * removed entirely rather than collapsed, since no valid matric number
 * contains a space.
 */
const matricNumber = z
  .string()
  .trim()
  .max(40)
  .transform((v) => v.replace(/\s+/g, '').toUpperCase())
  .optional()
  .or(z.literal(''));

/**
 * Registration identity fields — mandatory as of requirement 6.
 *
 * Previously all three were `.optional().or(z.literal(''))`, so the API
 * accepted a registration with none of them and the frontend's `required`
 * attributes were the only thing asking. A ticket then arrived with no way
 * to tell which faculty or department it came from, which is the reporting
 * dimension the whole board is filtered by.
 *
 * Declared here rather than in the route because this schema is the only
 * gate on POST /api/auth/signup: a crafted request with `{"faculty": ""}`
 * is rejected by `.min(1)` before the handler runs.
 *
 * Deliberately *not* a NOT NULL column. Students who registered before
 * this release have NULLs, and a constraint would either fail to apply or
 * force placeholder data onto real accounts. See 05_dev_role.sql §4.
 *
 * The empty-string variant is dropped on purpose — `.optional()` plus
 * `z.literal('')` is what made "" acceptable, and keeping either would
 * reintroduce the hole this closes.
 */
const requiredMatricNumber = z
  .string({ required_error: 'Please enter your matric number.' })
  .trim()
  .min(1, 'Please enter your matric number.')
  .max(40)
  // Same normalisation as the optional variant: whitespace stripped and
  // upper-cased, so "18/eng01/001" and "18/ENG01/001 " cannot both be
  // registered as distinct students.
  .transform((v) => v.replace(/\s+/g, '').toUpperCase())
  // Re-checked after the transform: a value of "   " passes .min(1) as
  // typed and collapses to "" here.
  .pipe(z.string().min(1, 'Please enter your matric number.'));

export const signupSchema = z.object({
  email:        z.string().trim().toLowerCase().email('Please enter a valid email address.'),
  password:     z.string().min(8, 'Password must be at least 8 characters.').max(72),
  fullName:     z.string().trim().min(2, 'Please enter your full name.').max(120),
  matricNumber: requiredMatricNumber,
  faculty:      z.string({ required_error: 'Please select your faculty.' })
                  .trim()
                  .min(1, 'Please select your faculty.')
                  .max(120),
  department:   z.string({ required_error: 'Please select your department.' })
                  .trim()
                  .min(1, 'Please select your department.')
                  .max(120),
  // NOTE: `role` is deliberately absent - it can never be set by the client.
});


export const updateProfileSchema = z.object({
  fullName:     z.string().trim().min(2).max(120).optional(),
  // Same normalisation on update — otherwise a student could sidestep the
  // signup check by registering without a matric number and adding a
  // differently-cased duplicate afterwards.
  matricNumber,
  faculty:      z.string().trim().max(120).optional().or(z.literal('')),
  department:   z.string().trim().max(120).optional().or(z.literal('')),
  avatarUrl:    z.string().url().max(500).optional().or(z.literal('')),
});

export const checkEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email('Please enter a valid email address.'),
});

export const appSettingsSchema = z.object({
  restrictSignupDomains: z.boolean(),
  allowedDomains: z.array(
    z.string().trim().toLowerCase()
      .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter a valid domain, e.g. abuad.edu.ng')
  ).max(20),
  allowSubdomains: z.boolean(),
  blockedDomains: z.array(z.string().trim().toLowerCase()).max(50).default([]),
});
