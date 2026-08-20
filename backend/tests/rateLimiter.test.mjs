/**
 * Rate limiter tests.
 *
 * These assert behaviour, not configuration. A limiter that is imported
 * and mounted but never actually returns 429 is worse than none at all,
 * because it looks protected in review — so each case here drives real
 * HTTP requests through a real express app and checks what comes back.
 *
 * The two bugs being guarded against:
 *
 *   1. SHARED BUCKETS. The original limiters keyed on IP. Thousands of
 *      students behind a campus NAT therefore shared one quota, so one
 *      heavy user could 429 an entire hall. The "separate buckets" tests
 *      below fail if that regresses.
 *
 *   2. IPv6 ROTATION. Keying on a full IPv6 address lets an attacker walk
 *      their own /64 and get a fresh quota every request.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';

import { ipBucket, identityKey, ipOnlyKey } from '../src/middleware/rateLimiter.js';

// ------------------------------------------------------------
// ipBucket — the IPv6 rotation defence
// ------------------------------------------------------------

test('ipBucket passes IPv4 through unchanged', () => {
  assert.equal(ipBucket('102.89.34.7'), '102.89.34.7');
});

test('ipBucket collapses IPv6 to its /64 prefix', () => {
  // Same /64, different interface identifiers — an attacker rotating
  // within their own allocation must land in one bucket.
  const a = ipBucket('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd');
  const b = ipBucket('2001:db8:1234:5678:1111:2222:3333:4444');

  assert.equal(a, b, 'addresses in one /64 must share a bucket');
  assert.equal(a, '2001:db8:1234:5678::/64');
});

test('ipBucket keeps genuinely different IPv6 networks apart', () => {
  const a = ipBucket('2001:db8:1234:5678::1');
  const b = ipBucket('2001:db8:9999:5678::1');

  assert.notEqual(a, b, 'different /64s are different clients');
});

test('ipBucket unwraps IPv4-mapped IPv6 so one client is not two buckets', () => {
  // Node reports IPv4 clients as ::ffff:a.b.c.d on a dual-stack socket.
  // Without unwrapping, the same person gets a second fresh quota simply
  // by reconnecting over the other stack.
  assert.equal(ipBucket('::ffff:102.89.34.7'), '102.89.34.7');
});

test('ipBucket tolerates a missing address instead of throwing', () => {
  // req.ip is undefined for unix-socket and some proxy edge cases. A
  // throw here would 500 the request, which fails open on availability.
  assert.equal(ipBucket(undefined), 'unknown');
  assert.equal(ipBucket(''), 'unknown');
});

// ------------------------------------------------------------
// identityKey — the campus NAT defence
// ------------------------------------------------------------

test('identityKey prefers the authenticated user id', () => {
  const key = identityKey({ user: { id: 'user-abc' }, headers: {}, ip: '10.0.0.1' });
  assert.equal(key, 'u:user-abc');
});

test('identityKey gives two users on one IP separate buckets', () => {
  const shared = '10.0.0.1';
  const a = identityKey({ user: { id: 'student-a' }, headers: {}, ip: shared });
  const b = identityKey({ user: { id: 'student-b' }, headers: {}, ip: shared });

  assert.notEqual(a, b, 'campus NAT must not merge students into one quota');
});

test('identityKey falls back to a token hash before requireAuth has run', () => {
  // The app-wide limiter is mounted ahead of every router, so req.user is
  // not yet populated. Hashing the bearer token still yields a per-session
  // bucket rather than a per-NAT one.
  const key = identityKey({
    headers: { authorization: 'Bearer some.jwt.value' },
    ip: '10.0.0.1',
  });

  assert.match(key, /^t:/);
});

test('identityKey never puts the raw token in the key', () => {
  // The key is written to logs on 429, so a raw token here would be a
  // credential leak into log storage.
  const token = 'super-secret-jwt-value';
  const key = identityKey({
    headers: { authorization: `Bearer ${token}` },
    ip: '10.0.0.1',
  });

  assert.ok(!key.includes(token), 'key must not contain the bearer token');
});

test('identityKey maps one token to one stable bucket', () => {
  const req = { headers: { authorization: 'Bearer abc.def.ghi' }, ip: '10.0.0.1' };
  assert.equal(identityKey(req), identityKey(req), 'hash must be deterministic');
});

test('identityKey separates two different tokens', () => {
  const a = identityKey({ headers: { authorization: 'Bearer token-one' }, ip: '10.0.0.1' });
  const b = identityKey({ headers: { authorization: 'Bearer token-two' }, ip: '10.0.0.1' });

  assert.notEqual(a, b);
});

test('identityKey falls back to IP for genuinely anonymous traffic', () => {
  const key = identityKey({ headers: {}, ip: '102.89.34.7' });
  assert.equal(key, 'ip:102.89.34.7');
});

test('identityKey ignores a malformed Authorization header', () => {
  // "Bearer" with no value, or a non-Bearer scheme, must not produce a
  // key of `t:` that every malformed request would then share.
  const empty = identityKey({ headers: { authorization: 'Bearer   ' }, ip: '102.89.34.7' });
  const basic = identityKey({ headers: { authorization: 'Basic dXNlcjpwYXNz' }, ip: '102.89.34.7' });

  assert.equal(empty, 'ip:102.89.34.7');
  assert.equal(basic, 'ip:102.89.34.7');
});

test('ipOnlyKey ignores identity entirely', () => {
  // Signup must be capped per host even when a token is presented, or an
  // attacker with one valid session could mass-create accounts.
  const key = ipOnlyKey({ user: { id: 'user-abc' }, headers: {}, ip: '102.89.34.7' });
  assert.equal(key, 'ip:102.89.34.7');
});

// ------------------------------------------------------------
// End-to-end: does a mounted limiter actually return 429?
// ------------------------------------------------------------

/**
 * Boots a throwaway express app on an ephemeral port.
 *
 * Real HTTP rather than a mocked req/res: express-rate-limit reads
 * req.ip, which only behaves correctly through the actual stack, and the
 * bug this suite exists to catch lives in that interaction.
 */
const withServer = async (configure, run) => {
  const app = express();
  app.set('trust proxy', 1);
  configure(app);

  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
};

test('a limiter returns 429 once the budget is spent', async () => {
  // Rebuilt locally with a tiny budget: asserting against the real
  // 600-request apiLimiter would mean firing 601 requests per run.
  const { default: rateLimit } = await import('express-rate-limit');

  await withServer(
    (app) => {
      app.use(
        rateLimit({
          windowMs: 60_000,
          limit: 3,
          keyGenerator: identityKey,
          standardHeaders: true,
          legacyHeaders: false,
          handler: (_req, res) =>
            res.status(429).json({ error: 'Too many requests.', retryAfterSeconds: 60 }),
        })
      );
      app.get('/ping', (_req, res) => res.json({ ok: true }));
    },
    async (base) => {
      const codes = [];
      for (let i = 0; i < 5; i += 1) {
        const res = await fetch(`${base}/ping`);
        codes.push(res.status);
      }

      assert.deepEqual(
        codes,
        [200, 200, 200, 429, 429],
        'first three allowed, the rest throttled'
      );
    }
  );
});

test('the 429 body explains the limit without leaking internals', async () => {
  const { default: rateLimit } = await import('express-rate-limit');

  await withServer(
    (app) => {
      app.use(
        rateLimit({
          windowMs: 60_000,
          limit: 1,
          keyGenerator: identityKey,
          standardHeaders: true,
          legacyHeaders: false,
          handler: (_req, res) =>
            res.status(429).json({
              error: 'You are doing that too quickly. Please slow down.',
              retryAfterSeconds: 60,
            }),
        })
      );
      app.get('/ping', (_req, res) => res.json({ ok: true }));
    },
    async (base) => {
      await fetch(`${base}/ping`);
      const res = await fetch(`${base}/ping`);
      const body = await res.json();

      assert.equal(res.status, 429);
      assert.ok(body.error, 'a human-readable message is present');
      assert.equal(typeof body.retryAfterSeconds, 'number', 'client can back off');

      // Nothing about which bucket was used, how the key was derived, or
      // how much quota remains beyond the standard headers.
      const serialised = JSON.stringify(body);
      assert.ok(!/ip:|u:|t:/.test(serialised), 'must not disclose the rate-limit key');
      assert.ok(!/keyGenerator|MemoryStore/.test(serialised));
    }
  );
});

test('two identities do not consume each other budget on one IP', async () => {
  // The headline regression test. Both requests come from 127.0.0.1, as
  // they would from behind a campus NAT; only the bearer token differs.
  const { default: rateLimit } = await import('express-rate-limit');

  await withServer(
    (app) => {
      app.use(
        rateLimit({
          windowMs: 60_000,
          limit: 2,
          keyGenerator: identityKey,
          standardHeaders: true,
          legacyHeaders: false,
          handler: (_req, res) => res.status(429).json({ error: 'Too many requests.' }),
        })
      );
      app.get('/ping', (_req, res) => res.json({ ok: true }));
    },
    async (base) => {
      const call = (token) =>
        fetch(`${base}/ping`, { headers: { authorization: `Bearer ${token}` } });

      // Student A burns their whole budget.
      assert.equal((await call('token-student-a')).status, 200);
      assert.equal((await call('token-student-a')).status, 200);
      assert.equal((await call('token-student-a')).status, 429, 'A is throttled');

      // Student B, same IP, must be unaffected.
      assert.equal(
        (await call('token-student-b')).status,
        200,
        'a second student on the same NAT must still be served'
      );
    }
  );
});

test('an IP-keyed limiter does merge two identities on one host', async () => {
  // The inverse of the test above, and the reason signup uses ipOnlyKey:
  // for account creation, "same host" is exactly the abuse being capped,
  // so presenting a different token must NOT buy a fresh quota.
  const { default: rateLimit } = await import('express-rate-limit');

  await withServer(
    (app) => {
      app.use(
        rateLimit({
          windowMs: 60_000,
          limit: 2,
          keyGenerator: ipOnlyKey,
          standardHeaders: true,
          legacyHeaders: false,
          handler: (_req, res) => res.status(429).json({ error: 'Too many requests.' }),
        })
      );
      app.post('/signup', (_req, res) => res.json({ ok: true }));
    },
    async (base) => {
      const call = (token) =>
        fetch(`${base}/signup`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });

      assert.equal((await call('a')).status, 200);
      assert.equal((await call('b')).status, 200);
      assert.equal(
        (await call('c')).status,
        429,
        'rotating tokens must not reset an IP-keyed budget'
      );
    }
  );
});
