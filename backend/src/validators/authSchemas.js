import { z } from 'zod';

export const signupSchema = z.object({
  email:        z.string().trim().toLowerCase().email('Please enter a valid email address.'),
  password:     z.string().min(8, 'Password must be at least 8 characters.').max(72),
  fullName:     z.string().trim().min(2, 'Please enter your full name.').max(120),
  matricNumber: z.string().trim().max(40).optional().or(z.literal('')),
  faculty:      z.string().trim().max(120).optional().or(z.literal('')),
  department:   z.string().trim().max(120).optional().or(z.literal('')),
  // NOTE: `role` is deliberately absent — it can never be set by the client.
});

export const updateProfileSchema = z.object({
  fullName:     z.string().trim().min(2).max(120).optional(),
  matricNumber: z.string().trim().max(40).optional().or(z.literal('')),
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
