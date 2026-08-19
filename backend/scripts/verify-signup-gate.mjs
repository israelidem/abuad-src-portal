/**
 * End-to-end check of the registration switch, against the live API.
 *
 *   node scripts/verify-signup-gate.mjs
 *
 * The unit tests in tests/signupControl.test.mjs prove the decision
 * function is correct. They cannot prove that the running server reads the
 * database, that the migration landed, or that the Prisma client is in
 * sync — all three of which broke during Phase 5 while every unit test
 * stayed green.
 *
 * So this drives the real thing:
 *
 *   1. read the switch straight from the database
 *   2. close it, and confirm POST /api/auth/signup returns 403
 *   3. open it, and confirm signup is accepted
 *   4. restore the original value
 *
 * Requires the dev server to be running. Writes to app_settings and
 * creates one throwaway auth user, which it deletes — so this is for local
 * and staging, not production.
 */

import { prisma } from '../src/lib/prisma.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { invalidateSettingsCache } from '../src/services/settingsService.js';

const API = process.env.API_URL ?? 'http://localhost:5000';

let passed = 0;
let failed = 0;

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? (passed += 1) : (failed += 1);
};

/** Flips the switch in the database, bypassing the API's own auth. */
const setSwitch = async (allowStudentSignups, signupClosedMessage = null) => {
  await prisma.appSettings.update({
    where: { id: 1 },
    data: { allowStudentSignups, signupClosedMessage },
  });
  // Only clears THIS process's cache. The server holds its own module
  // instance, so it keeps serving cached settings for up to CACHE_TTL_MS —
  // see waitForStatus().
  invalidateSettingsCache();
};

/**
 * Polls the public status endpoint until it reflects the expected value.
 *
 * Enforcement is immediate — the signup route reads with `fresh: true`, so
 * a closed gate rejects on the very next request. But the *advertised*
 * status comes from the 10-second settings cache, so a poll that runs
 * straight after a flip can legitimately read the old value.
 *
 * That is the documented cache tradeoff, not a bug, so this waits rather
 * than asserting immediately. Worth knowing operationally: after an admin
 * toggles registration, the banner can lag the enforcement by a few
 * seconds.
 */
const waitForStatus = async (predicate, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fetch(`${API}/api/admin/maintenance`).then((r) => r.json());
    if (predicate(last)) return { ok: true, status: last, waitedOut: false };
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return { ok: false, status: last, waitedOut: true };
};

/**
 * Pulls a human-readable message out of an error body.
 *
 * The handler returns `{ error: "text" }`; earlier drafts of this script
 * assumed `{ error: { message } }`. Accept both so the check tests the
 * behaviour rather than one particular envelope.
 */
const errorText = (body) =>
  typeof body?.error === 'string' ? body.error : (body?.error?.message ?? body?.message ?? '');

const attemptSignup = async (email) => {
  const response = await fetch(`${API}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'correct-horse-battery-staple',
      fullName: 'Gate Verification',
    }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

/** Removes an account this script created, so re-runs stay clean. */
const deleteUser = async (userId) => {
  if (!userId) return;
  await prisma.profile.delete({ where: { id: userId } }).catch(() => {});
  await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {});
};

const main = async () => {
  // Reachability first: without this, every assertion below fails with a
  // confusing fetch error rather than "the server isn't running".
  try {
    // /health, not /api/health — the probe is mounted at the root, above
    // the /api router.
    const health = await fetch(`${API}/health`);
    if (!health.ok) throw new Error(`health returned ${health.status}`);
  } catch (error) {
    console.error(`\nCannot reach ${API} — is the dev server running?`);
    console.error(`  ${error.message}\n`);
    process.exit(1);
  }

  const original = await prisma.appSettings.findUnique({ where: { id: 1 } });
  if (!original) {
    console.error('\nNo settings row. Run prisma/sql/07_signup_control.sql first.\n');
    process.exit(1);
  }

  console.log(`\nVerifying the signup gate against ${API}`);
  console.log(`(current value: allowStudentSignups = ${original.allowStudentSignups})\n`);

  const created = [];

  try {
    // --- Closed ------------------------------------------------------
    console.log('signups CLOSED');
    const closedMessage = 'Registration reopens on 1 October.';
    await setSwitch(false, closedMessage);

    // Enforcement is checked first and without waiting — this is the part
    // that must be instant.
    const rejected = await attemptSignup(`gate-closed-${Date.now()}@abuad.edu.ng`);
    check('direct API signup is rejected with 403', rejected.status === 403, `got ${rejected.status}`);
    check(
      'rejection explains why, using the admin message',
      errorText(rejected.body) === closedMessage,
      JSON.stringify(rejected.body).slice(0, 120)
    );

    const closed = await waitForStatus((s) => s.allowStudentSignups === false);
    check(
      'public status reports signups closed',
      closed.ok,
      closed.waitedOut ? 'still stale after 15s — cache is not expiring' : ''
    );
    check(
      'custom message is published for the UI',
      closed.status?.signupClosedMessage === closedMessage,
      JSON.stringify(closed.status?.signupClosedMessage)
    );

    // --- Open --------------------------------------------------------
    console.log('\nsignups OPEN');
    await setSwitch(true, null);

    const accepted = await attemptSignup(`gate-open-${Date.now()}@abuad.edu.ng`);
    check('signup is accepted with 201', accepted.status === 201, `got ${accepted.status}`);
    if (accepted.body.userId) created.push(accepted.body.userId);

    const open = await waitForStatus((s) => s.allowStudentSignups === true);
    check(
      'public status reports signups open',
      open.ok,
      open.waitedOut ? 'still stale after 15s — cache is not expiring' : ''
    );
  } finally {
    // Always restore, even if an assertion threw — leaving registration
    // closed on a shared environment would be a self-inflicted outage.
    await setSwitch(original.allowStudentSignups, original.signupClosedMessage);
    for (const id of created) await deleteUser(id);

    console.log(
      `\nRestored allowStudentSignups = ${original.allowStudentSignups}` +
        (created.length ? `, removed ${created.length} test account(s)` : '')
    );
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
