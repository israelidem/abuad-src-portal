/**
 * Signup email-domain policy.
 *
 * Development: unrestricted (gmail, yahoo, ...).
 * Launch: admin flips `restrictSignupDomains` on with
 * allowedDomains = ['abuad.edu.ng'] — no redeploy required.
 *
 * Enforced in two places:
 *   1. here, in the API (friendly errors)
 *   2. a Postgres trigger on auth.users (unbypassable)
 */

import { prisma } from '../lib/prisma.js';

const CACHE_TTL_MS = 30_000;
let cache = { value: null, expiresAt: 0 };

export const getSettings = async ({ fresh = false } = {}) => {
  if (!fresh && cache.value && Date.now() < cache.expiresAt) return cache.value;

  let settings = await prisma.appSettings.findUnique({ where: { id: 1 } });

  // Self-heal if the seed row is missing
  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { id: 1, restrictSignupDomains: false, allowedDomains: [], blockedDomains: [] },
    });
  }

  cache = { value: settings, expiresAt: Date.now() + CACHE_TTL_MS };
  return settings;
};

export const invalidateSettingsCache = () => {
  cache = { value: null, expiresAt: 0 };
};

const matches = (domain, pattern, allowSubdomains) => {
  const p = pattern.toLowerCase().trim();
  return domain === p || (allowSubdomains && domain.endsWith(`.${p}`));
};

/**
 * @returns {{ allowed: boolean, reason?: string }}
 */
export const checkEmailDomain = async (email, settings = null) => {
  const s = settings ?? (await getSettings());
  const domain = String(email).toLowerCase().split('@')[1];

  if (!domain) return { allowed: false, reason: 'Invalid email address.' };

  // Blocklist applies even when restriction is off (disposable mail, etc.)
  const blocked = (s.blockedDomains ?? []).some((d) =>
    matches(domain, d, s.allowSubdomains)
  );
  if (blocked) {
    return { allowed: false, reason: `Email addresses from "${domain}" are not permitted.` };
  }

  if (!s.restrictSignupDomains) return { allowed: true };

  const allowed = (s.allowedDomains ?? []).some((d) =>
    matches(domain, d, s.allowSubdomains)
  );

  return allowed
    ? { allowed: true }
    : {
        allowed: false,
        reason: `Registration is restricted to approved email domains: ${(s.allowedDomains ?? []).join(', ')}.`,
      };
};

/** True when the address sits inside an officially approved domain. */
export const isApprovedDomain = async (email) => {
  const s = await getSettings();
  const domain = String(email).toLowerCase().split('@')[1];
  if (!domain) return false;
  return (s.allowedDomains ?? []).some((d) => matches(domain, d, s.allowSubdomains));
};
