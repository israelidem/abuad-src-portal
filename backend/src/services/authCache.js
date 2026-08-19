/**
 * Short-lived cache for resolved sessions.
 *
 * THE MEASUREMENT THAT JUSTIFIES THIS
 *
 * requireAuth did two network round trips before any route handler ran:
 *
 *   supabaseAdmin.auth.getUser(token)   ~200ms  (HTTPS to Supabase Auth)
 *   prisma.profile.findUnique(id)       ~600ms  (SQL to Supabase Postgres)
 *
 * (Measured with scripts/measure-latency.mjs from Lagos; the absolute
 * numbers are inflated by distance to the Supabase region, but both are
 * remote calls wherever the server runs.)
 *
 * That cost is paid *per request*. A page that makes four API calls pays it
 * four times, sequentially, before doing any work. This is the most likely
 * cause of "slow even after the backend is warm" — and it is independent of
 * the host, so moving off Render would not have fixed it.
 *
 * WHY A CACHE IS SAFE HERE, AND HOW IT STAYS SAFE
 *
 * Caching authorisation is exactly the kind of optimisation that quietly
 * becomes a vulnerability, so the rules are deliberately strict:
 *
 * 1. TTL is seconds, not minutes. The window is meant to absorb the burst
 *    of calls from one page load, nothing more.
 *
 * 2. The token's own expiry always wins. A cache entry never outlives the
 *    JWT's `exp`, so a cached session cannot extend a token's life.
 *
 * 3. Privilege changes invalidate immediately. Role changes and
 *    deactivations call invalidateUser(), so a demoted admin does not keep
 *    admin rights until the TTL lapses. This is the part that makes the
 *    difference between a cache and a security bug.
 *
 * 4. Only successes are cached. A rejected token is re-checked every time,
 *    so this can never be used to make a bad token look valid.
 *
 * 5. Keys are hashes, not tokens. The map is keyed by SHA-256 of the token
 *    so raw bearer tokens are not sitting in a long-lived structure — a
 *    heap dump or accidental log of the cache leaks nothing usable.
 *
 * 6. Memory is bounded. An unbounded map keyed by attacker-supplied tokens
 *    is a denial-of-service vector, so entries are capped and pruned.
 *
 * WHAT THIS IS NOT
 *
 * Not a session store, and not a replacement for verifying tokens. Every
 * token is still verified by Supabase — just not re-verified several times
 * per second for the same page load.
 */

import { createHash } from 'node:crypto';

/**
 * Six seconds.
 *
 * Long enough to cover one page's burst of parallel requests (and a user
 * clicking around), short enough that a stale profile is a non-event. The
 * invalidation hooks handle correctness; the TTL is only a backstop.
 */
const TTL_MS = 6_000;

/**
 * Cap on tracked sessions.
 *
 * Each entry is small, but the key is supplied by the caller, so without a
 * cap anyone could grow this map indefinitely by sending random tokens.
 * Only verified tokens are ever stored, which already limits this to real
 * users, but the cap means the worst case is bounded regardless.
 */
const MAX_ENTRIES = 5_000;

/** hash(token) -> { profile, authUser, expiresAt } */
const sessions = new Map();

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

/**
 * Reads the JWT `exp` claim without verifying the signature.
 *
 * Verification is Supabase's job and has already happened by the time this
 * is called — we only need to know when the token dies so the cache entry
 * can be capped to match. A malformed token yields null, and the caller
 * then falls back to the TTL, so a bad parse cannot extend anything.
 */
const tokenExpiry = (token) => {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
};

/** Drops expired entries, and the oldest ones if the map is over budget. */
const prune = () => {
  const now = Date.now();

  for (const [key, entry] of sessions) {
    if (entry.expiresAt <= now) sessions.delete(key);
  }

  // Map preserves insertion order, so the front is the oldest.
  if (sessions.size > MAX_ENTRIES) {
    const excess = sessions.size - MAX_ENTRIES;
    let removed = 0;
    for (const key of sessions.keys()) {
      sessions.delete(key);
      if (++removed >= excess) break;
    }
  }
};

/**
 * Returns a cached session, or null.
 *
 * Deliberately returns null rather than a stale entry once expired: the
 * caller then does the full verification, which is the safe direction.
 */
export const getCachedSession = (token) => {
  const entry = sessions.get(hashToken(token));
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    sessions.delete(hashToken(token));
    return null;
  }

  return entry;
};

/**
 * Caches a verified session.
 *
 * The entry expires at whichever comes first: our short TTL, or the token's
 * own expiry. The second half is what stops the cache from ever making an
 * expired token usable.
 */
export const cacheSession = (token, profile, authUser) => {
  const exp = tokenExpiry(token);
  const expiresAt = Math.min(Date.now() + TTL_MS, exp ?? Infinity);

  // Already expired — nothing worth storing.
  if (expiresAt <= Date.now()) return;

  sessions.set(hashToken(token), { profile, authUser, expiresAt });

  if (sessions.size > MAX_ENTRIES) prune();
};

/**
 * Forgets every cached session for one user.
 *
 * MUST be called whenever a profile's authorisation-relevant state changes
 * — role, isActive. Without this, an admin demoting a user or deactivating
 * an account would have no effect for up to TTL_MS, which is precisely the
 * failure that makes cached authorisation dangerous.
 *
 * Sessions are keyed by token hash, so this scans. With TTL_MS of entries
 * the map is small, and role changes are rare administrative actions — the
 * cost is irrelevant next to being correct immediately.
 */
export const invalidateUser = (userId) => {
  for (const [key, entry] of sessions) {
    if (entry.profile?.id === userId) sessions.delete(key);
  }
};

/** Clears everything. For tests, and for a global "log everyone out". */
export const invalidateAllSessions = () => sessions.clear();

/** Diagnostics only. */
export const authCacheStats = () => ({ size: sessions.size, ttlMs: TTL_MS });
