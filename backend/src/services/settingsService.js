/**
 * App settings — single-row table, read on nearly every write request.
 *
 * Cached in memory for a few seconds because the maintenance-mode check
 * runs on every mutating request. Without the cache, turning on a boolean
 * would add a database round-trip to every POST/PATCH/DELETE in the app.
 *
 * The TTL is the tradeoff: flipping maintenance mode takes up to
 * CACHE_TTL_MS to reach every instance. Seconds are fine for this; minutes
 * would not be.
 */

import { prisma } from '../lib/prisma.js';
import { SETTING_DEFAULTS } from '../config/settingsRegistry.js';

const CACHE_TTL_MS = 10_000;

/**
 * Fallback values, derived from the registry rather than repeated here.
 *
 * This was a hand-written object, and it drifted from the database during
 * Phase 5 — the portal served stale defaults (registration open, domain
 * allow-list ignored) with nothing in the logs. Deriving it means the
 * fallback cannot silently disagree with the registry again.
 *
 * The registry requires every default to fail open, so a settings read
 * failure leaves the portal usable rather than looking like an outage.
 */
const DEFAULTS = SETTING_DEFAULTS;

let cache = null;
let cachedAt = 0;

/**
 * Throttle for the fallback warning.
 *
 * getSettings() runs on nearly every mutating request, so an unthrottled
 * log line would emit thousands of identical entries a minute and bury the
 * thing it is trying to report.
 */
let lastWarnedAt = 0;
const WARN_INTERVAL_MS = 60_000;

/**
 * Reports that we are serving DEFAULTS instead of real settings.
 *
 * This used to be a bare `catch {}`. The failure mode that justifies the
 * noise: if a migration adds a column to the Prisma schema but the SQL
 * hasn't been applied, Prisma selects a column that doesn't exist, every
 * read throws 42703, and the portal quietly runs on defaults — signups
 * open and the domain allow-list ignored — with nothing in the logs.
 */
const warnFallback = (error) => {
  if (Date.now() - lastWarnedAt < WARN_INTERVAL_MS) return;
  lastWarnedAt = Date.now();

  const drift = error?.meta?.code === '42703' || /does not exist/i.test(error?.message ?? '');

  console.error(
    `[settings] read failed — serving ${cache ? 'stale cache' : 'DEFAULTS'}: ${error?.message?.split('\n')[0]}` +
      (drift
        ? '\n[settings] a column is missing: the Prisma schema is ahead of the database.' +
          '\n[settings] domain policy and maintenance mode are NOT being applied.' +
          '\n[settings] run the pending migration in backend/prisma/sql, then restart.'
        : '')
  );
};

/** Drops the cache so the next read hits the database. */
export const invalidateSettingsCache = () => {
  cache = null;
  cachedAt = 0;
};

/**
 * Reads the settings row, creating it on first use.
 *
 * Falls back to DEFAULTS if the query fails. A database blip should not
 * take the whole API down, and defaulting `maintenanceMode` to false means
 * we fail open rather than locking every student out.
 */
export const getSettings = async ({ fresh = false } = {}) => {
  if (!fresh && cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;

  try {
    const settings = await prisma.appSettings.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    });

    cache = settings;
    cachedAt = Date.now();
    return settings;
  } catch (error) {
    // Still fails open — a settings blip must not take the API down — but
    // no longer silently.
    warnFallback(error);
    return cache ?? DEFAULTS;
  }
};

/** Updates settings and refreshes the cache in one step. */
export const updateSettings = async (data, actorId) => {
  const settings = await prisma.appSettings.upsert({
    where: { id: 1 },
    update: { ...data, updatedById: actorId },
    create: { id: 1, ...data, updatedById: actorId },
  });

  cache = settings;
  cachedAt = Date.now();
  return settings;
};
