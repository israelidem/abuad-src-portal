/**
 * Read-only confirmation that the database-level protections are live.
 *
 * Every other check in this repo runs against application code. This one
 * asks the database directly, because that is the only layer that actually
 * stops a student who has opened the browser console and started talking to
 * PostgREST. Express can be bypassed; a trigger cannot.
 *
 * It exists because an unapplied migration is invisible from the code side:
 * the SQL file sits in the repo looking authoritative while the database
 * knows nothing about it. That is exactly the gap this script found on its
 * first run (see the anon/ upload policy check below).
 *
 * Nothing here writes — it inspects catalogue tables only, so it is safe to
 * run against production at any time.
 *
 * Usage: npm run verify:rls
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: [] });

let passed = 0;
let failed = 0;

const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✔ ${label}`);
    passed += 1;
  } else {
    console.log(`  x ${label}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
};

/**
 * Tables holding student data, using their real names.
 *
 * The first version of this script guessed `comments`/`votes`/`ratings` and
 * reported them "not present", which reads as reassuring and means nothing.
 * Wrong table names in a security check are worse than no check.
 */
const PROTECTED = [
  'profiles',
  'tickets',
  'ticket_comments',
  'ticket_attachments',
  'ticket_votes',
  'ticket_ratings',
  'ticket_events',
  'notifications',
  'announcements',
  'push_subscriptions',
  'audit_logs',
  'app_settings',
];

const main = async () => {
  console.log('\nVerifying database-level protections (read-only)\n');

  // --- 1. The privilege-escalation guard -------------------------------
  // The single most important object in the schema. Without it, one line
  // in a browser console makes a student a SUPER_ADMIN.
  console.log('Privilege escalation');

  const triggers = await prisma.$queryRawUnsafe(`
    SELECT tgname, tgenabled, pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'profiles' AND NOT t.tgisinternal
  `);

  // Matched on the function it calls rather than the trigger's name, so a
  // rename doesn't silently turn this check into a pass.
  const guard = triggers.find((t) => /protect_profile_privileged_columns/i.test(t.def));

  check(
    'the profile column guard is attached to profiles',
    Boolean(guard),
    triggers.length ? `triggers found: ${triggers.map((t) => t.tgname).join(', ')}` : 'no triggers at all'
  );

  if (guard) {
    // 'D' = disabled. The trigger would still appear in a schema dump, so
    // this is the difference between protected and merely present.
    check(`"${guard.tgname}" is enabled`, guard.tgenabled !== 'D', `tgenabled = ${guard.tgenabled}`);
    check('it runs BEFORE UPDATE (blocks rather than records)', /BEFORE UPDATE/i.test(guard.def));
  }

  // The function must be SECURITY DEFINER, or the helper calls inside it
  // run with the caller's rights and the guard can be reasoned around.
  const [fn] = await prisma.$queryRawUnsafe(`
    SELECT prosecdef, pg_get_functiondef(oid) AS def
    FROM pg_proc WHERE proname = 'protect_profile_privileged_columns'
  `);

  if (fn) {
    check('the guard runs as SECURITY DEFINER', fn.prosecdef === true);
    for (const col of ['role', 'is_active', 'email', 'department_id']) {
      check(`it rejects changes to ${col}`, new RegExp(`new\\.${col} is distinct from old\\.${col}`, 'i').test(fn.def));
    }
  } else {
    check('the guard function exists', false, 'protect_profile_privileged_columns not found');
  }

  // --- 2. RLS is switched on -------------------------------------------
  // Policies on a table with RLS disabled are inert decoration.
  console.log('\nRow Level Security');

  const rls = await prisma.$queryRawUnsafe(`
    SELECT c.relname AS table, c.relrowsecurity AS enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  `);
  const byName = new Map(rls.map((r) => [r.table, r]));

  const missingTables = PROTECTED.filter((t) => !byName.has(t));
  check('every expected table exists', missingTables.length === 0, missingTables.join(', '));

  const rlsOff = PROTECTED.filter((t) => byName.has(t) && byName.get(t).enabled !== true);
  check(`RLS enabled on all ${PROTECTED.length} protected tables`, rlsOff.length === 0, rlsOff.join(', '));

  // Nothing in public should be left unguarded, including tables added later.
  const anyOff = rls.filter((r) => r.enabled !== true).map((r) => r.table);
  check('no public table has RLS disabled', anyOff.length === 0, anyOff.join(', '));

  // --- 3. Update policies constrain the resulting row ------------------
  // This was the original hole: USING without WITH CHECK lets a row be
  // updated *into* a state the policy would never have permitted.
  console.log('\nUpdate policies constrain the new row');

  const policies = await prisma.$queryRawUnsafe(`
    SELECT tablename, policyname, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = 'public'
  `);

  const updatePolicies = policies.filter((p) => p.cmd === 'UPDATE' || p.cmd === 'ALL');
  const missingCheck = updatePolicies.filter((p) => !p.with_check);

  check(
    'every UPDATE/ALL policy has a WITH CHECK clause',
    missingCheck.length === 0,
    missingCheck.map((p) => `${p.tablename}.${p.policyname}`).join(', ')
  );
  check('profiles has an UPDATE policy', updatePolicies.some((p) => p.tablename === 'profiles'));

  // --- 4. Storage ------------------------------------------------------
  // The bucket is public-read deliberately: the issue board is viewable
  // while logged out and the client renders getPublicUrl() links. So the
  // thing worth checking is not `public = false` — it is that writes are
  // still scoped, and that anonymous uploads have somewhere to land.
  console.log('\nStorage');

  try {
    const buckets = await prisma.$queryRawUnsafe(
      `SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets`
    );
    const bucket = buckets.find((b) => b.id === 'ticket-attachments');

    check('the ticket-attachments bucket exists', Boolean(bucket));

    if (bucket) {
      check('a file size limit is set', Number(bucket.file_size_limit) > 0, `${bucket.file_size_limit} bytes`);
      check(
        'MIME types are restricted to images',
        Array.isArray(bucket.allowed_mime_types) &&
          bucket.allowed_mime_types.length > 0 &&
          bucket.allowed_mime_types.every((m) => m.startsWith('image/')),
        JSON.stringify(bucket.allowed_mime_types)
      );
    }

    const storagePolicies = await prisma.$queryRawUnsafe(`
      SELECT policyname, cmd, roles::text AS roles, qual, with_check
      FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
    `);

    const inserts = storagePolicies.filter((p) => p.cmd === 'INSERT');
    const ownerScoped = inserts.find((p) => /auth\.uid\(\)/.test(p.with_check ?? ''));
    const anonScoped = inserts.find((p) => /'anon'/.test(p.with_check ?? ''));

    check('uploads are restricted to authenticated users', inserts.every((p) => /authenticated/.test(p.roles)));
    check('identified uploads are scoped to the uploader’s folder', Boolean(ownerScoped));

    // 09_storage_anonymous.sql adds this. Without it the owner-scoped
    // policy is the only INSERT policy, and the client's anon/<uuid>/…
    // path fails the check — so anonymous submissions *with an attachment*
    // are rejected by Storage while identified ones succeed.
    check(
      'anonymous uploads under anon/ are permitted (09_storage_anonymous.sql)',
      Boolean(anonScoped),
      'missing — anonymous tickets with attachments will fail to upload'
    );

    const deletes = storagePolicies.filter((p) => p.cmd === 'DELETE');
    check(
      'deletes are scoped to the owner’s folder',
      deletes.length > 0 && deletes.every((p) => /auth\.uid\(\)/.test(p.qual ?? '')),
      'a broad delete policy would let one student remove another’s evidence'
    );
    check(
      'no client-side delete policy covers anon/',
      !deletes.some((p) => /'anon'/.test(p.qual ?? '')),
      'anonymous attachments should only be removable by the service role'
    );
  } catch (error) {
    console.log(`  – storage schema not readable with this role (${error.message.split('\n')[0]})`);
  }

  // --- Summary ---------------------------------------------------------
  console.log(
    `\n${policies.length} policies across ${new Set(policies.map((p) => p.tablename)).size} public tables`
  );
  console.log(`${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    console.log('Apply the relevant file from prisma/sql/ with `npm run sql:apply`,');
    console.log('then re-run. All of them are idempotent.\n');
  }

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
};

main().catch(async (error) => {
  console.error('\nVerification could not run:\n');
  console.error(error.message);
  await prisma.$disconnect();
  process.exit(1);
});
