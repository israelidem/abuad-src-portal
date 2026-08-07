/**
 * Validated environment configuration.
 *
 * Loads `.env` relative to this file rather than the current working
 * directory, so the server starts correctly no matter where it's launched
 * from. This has to happen here (not in server.js) because ESM hoists all
 * `import` statements above other top-level code — by the time server.js
 * could call dotenv, this module has already been evaluated.
 *
 * Throws at startup if a required variable is missing, so misconfiguration
 * surfaces immediately instead of at the first API call.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: path.join(backendRoot, '.env') });

const missing = [];

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    missing.push(name);
    return '';
  }
  return value;
};

const optional = (name, fallback = '') => process.env[name] ?? fallback;

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '5000'), 10),
  isDev: optional('NODE_ENV', 'development') !== 'production',

  supabase: {
    url: required('SUPABASE_URL'),
    anonKey: required('SUPABASE_ANON_KEY'),
    // Server-only. Bypasses RLS — never expose to the browser.
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },

  database: {
    url: required('DATABASE_URL'),
  },

  cors: {
    // Comma-separated list
    origins: optional('ALLOWED_ORIGINS', 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  },

  vapid: {
    publicKey: optional('VAPID_PUBLIC_KEY'),
    privateKey: optional('VAPID_PRIVATE_KEY'),
    subject: optional('VAPID_SUBJECT', 'mailto:admin@abuad.edu.ng'),
  },
};

// Report every missing variable at once rather than one per restart.
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}\n` +
      `Expected in: ${path.join(backendRoot, '.env')}\n` +
      `See backend/.env.example for the full list.`
  );
}
