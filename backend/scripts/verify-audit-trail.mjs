/**
 * Verifies the audit trail against the real database.
 *
 * Audit writes are deliberately non-blocking — an audit failure must never
 * fail the admin action that triggered it. That's the right trade-off, but
 * it means a missing table or a renamed column produces *no visible
 * symptom*: the settings save succeeds, and nothing is recorded. The only
 * way to know the trail works is to write to it and read it back.
 *
 * This script:
 *   1. confirms audit_logs exists and is reachable through Prisma
 *   2. writes a probe row via the real recordAudit() path
 *   3. reads it back and checks the before/after diff survived the JSON round-trip
 *   4. deletes the probe row
 *   5. prints any genuine audit entries already recorded
 *
 * Usage: npm run verify:audit
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

import { recordAudit, changes } from '../src/services/auditService.js';

const prisma = new PrismaClient();

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

const PROBE = '__verification_probe__';

const main = async () => {
  console.log('\nVerifying the audit trail\n');

  // --- 1. The table exists ---------------------------------------------
  console.log('Schema');

  let existing = null;
  try {
    existing = await prisma.auditLog.count();
    check(`audit_logs is reachable (${existing} rows)`, true);
  } catch (error) {
    check('audit_logs is reachable', false, `${error.code ?? ''} ${error.message.split('\n')[0]}`);
    console.log('\nThe table is missing. Apply prisma/sql/00_schema.sql (or the');
    console.log('relevant migration) before relying on the audit trail.\n');
    await prisma.$disconnect();
    process.exit(1);
  }

  // --- 2. A write actually lands ---------------------------------------
  console.log('\nWrite path');

  const diff = changes(
    { allowStudentSignups: true, portalName: 'ABUAD SRC' },
    { allowStudentSignups: false, portalName: 'ABUAD SRC' }
  );

  // A stand-in for the Express request. actorId is left null (the FK is
  // nullable) so the probe doesn't depend on a real profile row existing.
  const fakeReq = {
    user: undefined,
    ip: '127.0.0.1',
    // Silences the mirrored info log; the DB row is what's under test.
    log: { info: () => {}, error: (msg, ctx) => console.error(`     ${msg}`, ctx?.err?.message ?? '') },
  };

  // Goes through recordAudit(), not a raw create — so this exercises the
  // same code an admin action uses, including its non-fatal error path.
  await recordAudit(fakeReq, PROBE, 'AppSettings', PROBE, diff);

  const after = await prisma.auditLog.count();
  check('the row count increased', after === existing + 1, `${existing} → ${after}`);

  const probe = await prisma.auditLog.findFirst({
    where: { action: PROBE },
    orderBy: { createdAt: 'desc' },
  });

  check('the probe row can be read back', Boolean(probe));

  if (probe) {
    // --- 3. The diff survived the JSON column ------------------------
    console.log('\nRecorded content');

    // recordAudit stores whatever metadata it was handed; here that is the
    // diff itself, so the fields sit at the top level of metadata.
    const recorded = probe.metadata?.changes ?? probe.metadata;

    check(
      'the changed setting was recorded',
      Boolean(recorded?.allowStudentSignups),
      `metadata = ${JSON.stringify(probe.metadata)?.slice(0, 200)}`
    );
    check(
      'the previous value survived',
      recorded?.allowStudentSignups?.from === true,
      `got ${JSON.stringify(recorded?.allowStudentSignups?.from)}`
    );
    check(
      'the new value survived',
      recorded?.allowStudentSignups?.to === false,
      `got ${JSON.stringify(recorded?.allowStudentSignups?.to)}`
    );
    check(
      'the unchanged field was not recorded',
      recorded?.portalName === undefined
    );
    check('the action is recorded', probe.action === PROBE);
    check('the target is recorded', probe.entityType === 'AppSettings');
    check('the target row is recorded', probe.entityId === PROBE);
    check('a timestamp is recorded', probe.createdAt instanceof Date);
    check('the caller IP is recorded', probe.ipAddress === '127.0.0.1');

    // --- 4. Clean up --------------------------------------------------
    await prisma.auditLog.delete({ where: { id: probe.id } });
    const cleaned = await prisma.auditLog.count();
    check('the probe row was removed', cleaned === existing, `${cleaned} vs ${existing}`);
  }

  // --- 5. Show real entries -------------------------------------------
  const real = await prisma.auditLog.findMany({
    take: 10,
    orderBy: { createdAt: 'desc' },
    select: { action: true, entityType: true, createdAt: true, metadata: true },
  });

  console.log(`\nMost recent genuine entries (${real.length})`);
  if (real.length === 0) {
    console.log('  (none yet — perform an admin action, then re-run)');
  } else {
    for (const row of real) {
      // Two shapes exist in the wild: a per-field diff from changes(), and
      // the flat { from, to } that user.role_change passes. Rows written
      // before changes() existed have neither, and print as "—".
      const meta = row.metadata ?? {};
      const summary =
        'from' in meta && 'to' in meta
          ? `${meta.from} → ${meta.to}`
          : Object.entries(meta)
              .filter(([, v]) => v && typeof v === 'object' && 'to' in v)
              .map(([k, v]) => `${k}: ${v.from} → ${v.to}`)
              .join(', ') || '—';

      console.log(
        `  ${row.createdAt.toISOString()}  ${row.action.padEnd(20)}  ${row.entityType.padEnd(12)}  ${summary}`
      );
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
};

main().catch(async (error) => {
  console.error('\nVerification could not run:\n');
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
