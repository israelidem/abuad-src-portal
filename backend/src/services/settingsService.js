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

const CACHE_TTL_MS = 10_000;

const DEFAULTS = {
  id: 1,
  restrictSignupDomains: false,
  allowedDomains: [],
  allowSubdomains: true,
  blockedDomains: [],
  maintenanceMode: false,
  maintenanceMessage: null,
};

let cache = null;
let cachedAt = 0;

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
  } catch {
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
