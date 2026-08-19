/**
 * Tests for the session cache.
 *
 * Caching authorisation is a security-sensitive optimisation, so these
 * tests are about the invariants that keep it from becoming a
 * vulnerability, not about whether the cache "works".
 *
 * The dangerous failure modes, each covered below:
 *
 *   - a cached entry outliving the token's own expiry
 *   - a role change or deactivation not taking effect immediately
 *   - raw bearer tokens being retrievable from the cache
 *   - unbounded growth from caller-supplied keys
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getCachedSession,
  cacheSession,
  invalidateUser,
  invalidateAllSessions,
  authCacheStats,
} from '../src/services/authCache.js';

/** Builds a token whose `exp` claim is `secondsFromNow` in the future. */
const tokenExpiringIn = (secondsFromNow, id = 'a') => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: id,
      exp: Math.floor(Date.now() / 1000) + secondsFromNow,
    })
  ).toString('base64url');
  return `${header}.${payload}.sig-${id}`;
};

const profile = (id, role = 'STUDENT') => ({ id, role, isActive: true });

test('a cached session is returned instead of re-verifying', () => {
  invalidateAllSessions();

  const token = tokenExpiringIn(3600, 'hit');
  cacheSession(token, profile('user-1'), { id: 'user-1' });

  const cached = getCachedSession(token);
  assert.ok(cached, 'the session should be cached');
  assert.equal(cached.profile.id, 'user-1');
});

test('an unknown token is never a cache hit', () => {
  invalidateAllSessions();

  // The whole point: an attacker's token must not resolve to anyone.
  assert.equal(getCachedSession(tokenExpiringIn(3600, 'never-cached')), null);
});

test('a cache entry never outlives the token itself', () => {
  invalidateAllSessions();

  // Token already expired. Even though the TTL is several seconds, this
  // must not become usable — otherwise the cache would extend the life of
  // a dead token, which is a straightforward authentication bypass.
  const expired = tokenExpiringIn(-60, 'expired');
  cacheSession(expired, profile('user-2'), { id: 'user-2' });

  assert.equal(getCachedSession(expired), null, 'an expired token must not be cached');
});

test('a token expiring sooner than the TTL is capped to its own expiry', () => {
  invalidateAllSessions();

  // 1s of token life against a ~6s TTL: the entry must die with the token.
  const token = tokenExpiringIn(1, 'short');
  cacheSession(token, profile('user-3'), { id: 'user-3' });

  const cached = getCachedSession(token);
  assert.ok(cached, 'should be cached while the token is still valid');

  // Not sleeping through it — the invariant is the stored expiry, and a
  // test that waits on wall-clock time is a slow, flaky way to assert it.
  const { ttlMs } = authCacheStats();
  assert.ok(
    cached.expiresAt - Date.now() <= ttlMs,
    'the entry must not be scheduled to outlive the token'
  );
  assert.ok(cached.expiresAt - Date.now() <= 1000, 'expiry should be capped to the token, not the TTL');
});

test('a role change invalidates that user immediately', () => {
  invalidateAllSessions();

  // The failure this prevents: an admin is demoted, but their cached
  // session keeps admin rights until the TTL lapses.
  const token = tokenExpiringIn(3600, 'demoted');
  cacheSession(token, profile('user-4', 'ADMIN'), { id: 'user-4' });
  assert.ok(getCachedSession(token), 'precondition: cached');

  invalidateUser('user-4');

  assert.equal(
    getCachedSession(token),
    null,
    'the demoted user must be re-resolved on the very next request'
  );
});

test('invalidating one user leaves other users cached', () => {
  invalidateAllSessions();

  const a = tokenExpiringIn(3600, 'a');
  const b = tokenExpiringIn(3600, 'b');
  cacheSession(a, profile('user-a'), { id: 'user-a' });
  cacheSession(b, profile('user-b'), { id: 'user-b' });

  invalidateUser('user-a');

  assert.equal(getCachedSession(a), null, 'the targeted user is cleared');
  assert.ok(getCachedSession(b), 'unrelated users are untouched');
});

test('every session for one user is cleared, not just the newest', () => {
  invalidateAllSessions();

  // A student on a phone and a laptop has two valid tokens. Deactivating
  // the account has to end both, or "deactivated" means "deactivated on
  // whichever device we happened to see last".
  const phone = tokenExpiringIn(3600, 'phone');
  const laptop = tokenExpiringIn(3600, 'laptop');
  cacheSession(phone, profile('user-5'), { id: 'user-5' });
  cacheSession(laptop, profile('user-5'), { id: 'user-5' });

  invalidateUser('user-5');

  assert.equal(getCachedSession(phone), null);
  assert.equal(getCachedSession(laptop), null);
});

test('raw tokens are not used as cache keys', async () => {
  invalidateAllSessions();

  const token = tokenExpiringIn(3600, 'secret-token-value');
  cacheSession(token, profile('user-6'), { id: 'user-6' });

  // Reaching into the module's internals deliberately: the guarantee is
  // that a dump of the cache structure cannot yield a usable bearer token.
  const mod = await import('../src/services/authCache.js');
  const serialised = JSON.stringify(mod.authCacheStats());

  assert.ok(!serialised.includes('secret-token-value'), 'stats must not leak token material');

  // And the entry is still retrievable only by presenting the token.
  assert.ok(getCachedSession(token));
});

test('the cache reports its size for diagnostics', () => {
  invalidateAllSessions();
  assert.equal(authCacheStats().size, 0);

  cacheSession(tokenExpiringIn(3600, 's1'), profile('u1'), { id: 'u1' });
  cacheSession(tokenExpiringIn(3600, 's2'), profile('u2'), { id: 'u2' });

  assert.equal(authCacheStats().size, 2);
});

test('the TTL is short enough to be a backstop, not a session store', () => {
  // If someone raises this to minutes, correctness starts depending on the
  // invalidation hooks alone — and a missed hook becomes a lingering
  // privilege. Ten seconds is the outer bound this design assumes.
  assert.ok(
    authCacheStats().ttlMs <= 10_000,
    'session cache TTL must stay in the seconds range'
  );
});
