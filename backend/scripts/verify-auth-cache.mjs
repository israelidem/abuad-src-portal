/**
 * Verifies the session cache against a running API.
 *
 *   node server.js
 *   node scripts/verify-auth-cache.mjs
 *
 * The unit tests cover the cache module in isolation. They cannot show
 * that requireAuth is actually wired to it, that the speed-up is real, or
 * that a deactivated account still loses access immediately — those are
 * properties of the running system, and the second one is the property
 * that decides whether this optimisation is safe to keep.
 *
 * Creates one temporary student and deletes it at the end.
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { prisma } from '../src/lib/prisma.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:5000';

let passed = 0;
let failed = 0;

const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? (passed += 1) : (failed += 1);
};

const main = async () => {
  console.log(`\nVerifying the session cache against ${BASE}\n`);

  // --- a real signed-in student --------------------------------------
  const email = `cache-probe-${randomUUID().slice(0, 8)}@abuad.edu.ng`;
  const password = `Probe!${randomUUID().slice(0, 10)}`;

  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'Cache Probe' },
  });

  if (createError) {
    console.error(`Could not create the probe account: ${createError.message}\n`);
    process.exit(1);
  }

  const userId = created.user.id;

  const cleanup = async () => {
    // Deleting the auth user cascades to profiles (profiles.id references
    // auth.users), so deleteMany is used for the leftover check rather than
    // delete — delete throws when the row is already gone, which printed an
    // alarming Prisma error at the end of a successful run.
    await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {});
    await prisma.profile.deleteMany({ where: { id: userId } }).catch(() => {});
  };

  try {
    const { data: signIn, error: signInError } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      console.error(`Could not sign the probe in: ${signInError.message}\n`);
      await cleanup();
      process.exit(1);
    }

    const token = signIn.session.access_token;
    const authed = { Authorization: `Bearer ${token}` };

    const me = async () => {
      const started = performance.now();
      const res = await fetch(`${BASE}/api/auth/me`, { headers: authed });
      return { status: res.status, ms: performance.now() - started };
    };

    // --- the speed-up --------------------------------------------------
    console.log('cache hit vs full resolution');

    const cold = await me(); // populates the cache
    check(cold.status === 200, 'a valid token is accepted', `${cold.status} in ${cold.ms.toFixed(0)}ms`);

    // Three more inside the TTL. These should skip both the Supabase Auth
    // round trip and the profile query.
    const warm = [await me(), await me(), await me()];
    check(
      warm.every((r) => r.status === 200),
      'subsequent requests still succeed'
    );

    const warmest = Math.min(...warm.map((r) => r.ms));
    check(
      warmest < cold.ms,
      'a cached request is faster than the first',
      `first ${cold.ms.toFixed(0)}ms vs best cached ${warmest.toFixed(0)}ms`
    );

    // --- the invariant that makes it safe ------------------------------
    console.log('\ndeactivation takes effect immediately, not after the TTL');

    // This has to go through the real admin endpoint. Calling
    // invalidateUser() from this script would clear *this* process's cache,
    // not the server's, and would prove nothing — the question is whether
    // the admin route invalidates the cache the middleware actually reads.
    const superAdmin = await prisma.profile.findFirst({
      where: { role: 'SUPER_ADMIN', isActive: true },
      select: { id: true, email: true },
    });

    if (!superAdmin) {
      console.log('  SKIP  no active super admin to perform the deactivation');
    } else {
      // Mint a token for the super admin without needing their password.
      const { data: link } = await supabaseAdmin.auth.admin.generateLink({
        type: 'magiclink',
        email: superAdmin.email,
      });

      const { data: verified } = await supabaseAdmin.auth.verifyOtp({
        type: 'magiclink',
        token_hash: link?.properties?.hashed_token,
      });

      const adminToken = verified?.session?.access_token;

      if (!adminToken) {
        console.log('  SKIP  could not mint a super-admin token');
      } else {
        // The probe's session is cached and valid at this moment — the
        // request above just populated it. That is exactly the dangerous
        // state: if the cache ignored the deactivation, the account would
        // keep working.
        const before = await me();
        check(before.status === 200, 'precondition: the probe is cached and working');

        const res = await fetch(`${BASE}/api/admin/users/${userId}/status`, {
          method: 'PATCH',
          headers: { ...{ Authorization: `Bearer ${adminToken}` }, 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: false }),
        });

        check(res.ok, 'an admin can deactivate the account', `${res.status}`);

        // No sleep. The whole point is that this is immediate.
        const after = await me();
        check(
          after.status === 403,
          'the deactivated account is rejected on the very next request',
          `${after.status} — no TTL wait`
        );

        // Restore, and confirm reactivation is equally immediate.
        await fetch(`${BASE}/api/admin/users/${userId}/status`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: true }),
        });

        const restored = await me();
        check(restored.status === 200, 'reactivation is also immediate', `${restored.status}`);
      }
    }

    // --- a bad token is never cached -----------------------------------
    console.log('\nfailures are never cached');

    const badToken = `${token.slice(0, -4)}zzzz`;
    const first = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${badToken}` },
    });
    const second = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${badToken}` },
    });

    check(first.status === 401, 'a tampered token is rejected', `${first.status}`);
    check(second.status === 401, 'and rejected again, not cached as valid', `${second.status}`);

    const noToken = await fetch(`${BASE}/api/auth/me`);
    check(noToken.status === 401, 'no token is still 401', `${noToken.status}`);
  } finally {
    await cleanup();
    console.log('\nRemoved the probe account');
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
