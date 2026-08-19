/**
 * End-to-end check of the two new ticket settings, against the live API.
 *
 *   node scripts/verify-ticket-settings.mjs
 *
 * The registry tests prove the settings are well-formed. They cannot prove
 * that the running server enforces them — which is the whole point of a
 * setting, and exactly what broke in Phase 5: every unit test stayed green
 * while the server served stale defaults from a cache backed by columns
 * that did not exist yet.
 *
 * So this drives the real endpoints as a real student:
 *
 *   1. allowAnonymousTickets = false  ->  anonymous submission gets 403
 *   2. allowAnonymousTickets = true   ->  anonymous submission gets 201
 *   3. maxAttachmentsPerTicket = 1    ->  two attachments gets 400
 *   4. authorisation: a STUDENT cannot read or write settings
 *
 * Test 4 matters most. The settings screen is only linked for super admins,
 * but hiding a link is not access control — if the API does not check the
 * role, any student who reads the bundle can change portal policy.
 *
 * Writes to app_settings and creates one throwaway student, both restored
 * and deleted afterwards. Local and staging only.
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

const errorText = (body) =>
  typeof body?.error === 'string' ? body.error : (body?.error?.message ?? body?.message ?? '');

/** Writes settings directly, bypassing the API's own auth. */
const setSettings = async (data) => {
  await prisma.appSettings.update({ where: { id: 1 }, data });
  invalidateSettingsCache(); // this process only; the server has its own
};

/**
 * Creates a confirmed student and returns an access token.
 *
 * Uses the admin API rather than POST /api/auth/signup so this script keeps
 * working when registration is closed — otherwise the two verification
 * scripts would interfere with each other depending on run order.
 */
const createStudent = async () => {
  const email = `ticket-settings-${Date.now()}@abuad.edu.ng`;
  const password = 'correct-horse-battery-staple';

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'Ticket Settings Verification' },
  });
  if (error) throw new Error(`could not create test student: ${error.message}`);

  const { data: session, error: signInError } =
    await supabaseAdmin.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`could not sign in test student: ${signInError.message}`);

  return { id: data.user.id, token: session.session.access_token };
};

const postTicket = async (token, body) => {
  const response = await fetch(`${API}/api/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

/** A submission that passes validation, so only policy can reject it. */
const ticketBody = (extra = {}) => ({
  faculty: 'Engineering',
  category: 'ICT',
  description: 'Verification submission from scripts/verify-ticket-settings.mjs.',
  locationText: 'Test location',
  urgency: 'LOW',
  ...extra,
});

const attachment = (n) => ({
  storagePath: `verify/${Date.now()}-${n}.jpg`,
  mimeType: 'image/jpeg',
  sizeBytes: 1024,
});

const main = async () => {
  try {
    const health = await fetch(`${API}/health`);
    if (!health.ok) throw new Error(`health returned ${health.status}`);
  } catch (error) {
    console.error(`\nCannot reach ${API} — is the dev server running?`);
    console.error(`  ${error.message}\n`);
    process.exit(1);
  }

  const original = await prisma.appSettings.findUnique({ where: { id: 1 } });
  if (!original) {
    console.error('\nNo settings row. Run prisma/sql/08_settings_registry.sql first.\n');
    process.exit(1);
  }

  console.log(`\nVerifying ticket settings against ${API}\n`);

  const student = await createStudent();
  const createdTickets = [];

  try {
    // --- Anonymous submissions OFF -----------------------------------
    console.log('allowAnonymousTickets = false');
    await setSettings({ allowAnonymousTickets: false });

    const blocked = await postTicket(student.token, ticketBody({ isAnonymous: true }));
    check('anonymous submission is rejected with 403', blocked.status === 403, `got ${blocked.status}`);
    check(
      'rejection says why',
      /anonymous/i.test(errorText(blocked.body)),
      JSON.stringify(blocked.body).slice(0, 120)
    );

    // The switch must gate anonymity, not submissions in general.
    const named = await postTicket(student.token, ticketBody({ isAnonymous: false }));
    check('a named submission still works', named.status === 201, `got ${named.status}`);
    if (named.body?.ticket?.id) createdTickets.push(named.body.ticket.id);

    // --- Anonymous submissions ON ------------------------------------
    console.log('\nallowAnonymousTickets = true');
    await setSettings({ allowAnonymousTickets: true });

    const anon = await postTicket(student.token, ticketBody({ isAnonymous: true }));
    check('anonymous submission is accepted', anon.status === 201, `got ${anon.status}`);
    if (anon.body?.ticket?.id) createdTickets.push(anon.body.ticket.id);

    // What to assert here needs care. This response goes *to the author*,
    // and the author is meant to see their own name — otherwise they cannot
    // tell which anonymous report is theirs in "My tickets". Redaction for
    // everyone else is unit-tested in tests/ticketVisibility.test.mjs
    // ("the author identity is withheld from staff", "another student
    // learns nothing about the author"), so re-asserting it here would only
    // duplicate it — wrongly, from the one viewpoint that is exempt.
    //
    // The part that unit tests cannot see is the stored row: the flag has
    // to persist, and authorId has to survive, or the student silently
    // loses access to their own ticket.
    if (anon.body?.ticket?.id) {
      const stored = await prisma.ticket.findUnique({
        where: { id: anon.body.ticket.id },
        select: { isAnonymous: true, authorId: true },
      });
      check('the ticket is stored as anonymous', stored?.isAnonymous === true);
      check(
        'the internal author link is retained',
        stored?.authorId === student.id,
        'without it the student loses access to their own ticket'
      );
    }

    // --- Attachment cap ----------------------------------------------
    console.log('\nmaxAttachmentsPerTicket = 1');
    await setSettings({ maxAttachmentsPerTicket: 1 });

    const tooMany = await postTicket(
      student.token,
      ticketBody({ attachments: [attachment(1), attachment(2)] })
    );
    check('two attachments are rejected with 400', tooMany.status === 400, `got ${tooMany.status}`);
    check(
      'rejection states the limit',
      /at most 1 file/i.test(errorText(tooMany.body)),
      JSON.stringify(tooMany.body).slice(0, 140)
    );

    const justOne = await postTicket(student.token, ticketBody({ attachments: [attachment(3)] }));
    check('one attachment is accepted', justOne.status === 201, `got ${justOne.status}`);
    if (justOne.body?.ticket?.id) createdTickets.push(justOne.body.ticket.id);

    // --- Authorisation -----------------------------------------------
    // The UI hides this screen from students. That is presentation, not
    // protection: the check has to be on the route.
    console.log('\nsettings authorisation');

    const read = await fetch(`${API}/api/admin/settings`, {
      headers: { Authorization: `Bearer ${student.token}` },
    });
    check('a student cannot read settings', read.status === 403, `got ${read.status}`);

    const write = await fetch(`${API}/api/admin/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${student.token}` },
      body: JSON.stringify({ allowStudentSignups: false }),
    });
    check('a student cannot change settings', write.status === 403, `got ${write.status}`);

    const anonymous = await fetch(`${API}/api/admin/settings`);
    check('an unauthenticated caller cannot read settings', anonymous.status === 401, `got ${anonymous.status}`);

    // Proof the rejections were real rather than a coincidence of ordering.
    const after = await prisma.appSettings.findUnique({ where: { id: 1 } });
    check('the student\'s write did not land', after.allowStudentSignups === true);
  } finally {
    // Restore first — an interrupted run must not leave anonymity disabled.
    await setSettings({
      allowAnonymousTickets: original.allowAnonymousTickets,
      maxAttachmentsPerTicket: original.maxAttachmentsPerTicket,
    });

    for (const id of createdTickets) {
      await prisma.ticket.delete({ where: { id } }).catch(() => {});
    }
    await prisma.profile.delete({ where: { id: student.id } }).catch(() => {});
    await supabaseAdmin.auth.admin.deleteUser(student.id).catch(() => {});

    console.log(
      `\nRestored anonymity = ${original.allowAnonymousTickets}, ` +
        `attachment cap = ${original.maxAttachmentsPerTicket}; ` +
        `removed ${createdTickets.length} ticket(s) and 1 test account`
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
