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

  /**
   * Cloudinary — attachment storage.
   *
   * `optional`, not `required`, and that is a deliberate decision rather
   * than laziness. Existing deployments store attachments in Supabase
   * Storage; making these required would refuse to boot an otherwise
   * healthy server the moment this code ships, and would break every
   * environment (CI, local, the existing production instance) until
   * credentials were added everywhere. The upload route reports 503 when
   * unconfigured instead — a broken uploader is recoverable, a server that
   * will not start is not.
   *
   * `apiSecret` never leaves the server. It signs upload requests and
   * authenticates Admin API calls; the browser only ever receives a
   * signature, which is scoped to one upload and expires.
   *
   * `cloudName` and `apiKey` are not secrets — Cloudinary publishes both in
   * delivery URLs and expects the api_key in the upload request body. Only
   * the secret matters, which is why it is read here and never sent to a
   * client.
   */
  cloudinary: {
    cloudName: optional('CLOUDINARY_CLOUD_NAME'),
    apiKey: optional('CLOUDINARY_API_KEY'),
    apiSecret: optional('CLOUDINARY_API_SECRET'),
    /** Everything the portal uploads is namespaced under this folder. */
    folder: optional('CLOUDINARY_FOLDER', 'abuad-src-portal'),
  },
};

/**
 * Whether attachment uploads can work at all.
 *
 * Checked by the upload route so it can answer 503 with a clear message
 * rather than producing an invalid signature that fails opaquely at
 * Cloudinary.
 */
export const isCloudinaryConfigured = () =>
  Boolean(env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret);

// Report every missing variable at once rather than one per restart.
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}\n` +
      `Expected in: ${path.join(backendRoot, '.env')}\n` +
      `See backend/.env.example for the full list.`
  );
}
