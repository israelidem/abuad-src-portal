/**
 * Verifies the comment-moderation migration actually landed.
 *
 * Written because "I ran the SQL" and "the schema is correct" are
 * different claims. This checks the real database: every column the
 * insert path touches, both new tables, the CHECK constraints, and the
 * indexes the queue query depends on.
 *
 * It also does a live round-trip — insert a word, confirm the matcher
 * picks it up, delete it — which is the only way to prove the
 * "admin words apply without a redeploy" requirement is genuinely met
 * rather than merely wired.
 *
 *   node backend/scripts/verify-moderation.mjs
 */

import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { getActiveTerms, invalidateWordCache, normaliseTerm } from '../src/services/moderationService.js';
import { analyseText } from '../src/lib/textModeration.js';
import { ALLOWLIST } from '../src/config/moderationWordlist.js';

let failures = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => {
  failures += 1;
  console.log(`  FAIL  ${m}`);
};

const section = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

/** Reads real column metadata rather than trusting the Prisma schema. */
const columns = async (table) => {
  const rows = await prisma.$queryRaw`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return new Map(rows.map((r) => [r.column_name, r]));
};

const tableExists = async (table) => {
  const rows = await prisma.$queryRaw`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return rows.length > 0;
};

const indexNames = async (table) => {
  const rows = await prisma.$queryRaw`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ${table}
  `;
  return rows.map((r) => r.indexname);
};

const run = async () => {
  console.log('Comment moderation — migration verification');

  // ---------------------------------------------------------------
  section('1. ticket_comments columns');
  // ---------------------------------------------------------------
  const cols = await columns('ticket_comments');

  // These are exactly the columns the POST/PATCH insert path writes. If
  // any is missing, comment creation throws at runtime.
  const required = [
    'moderation_status',
    'moderation_reason',
    'moderation_categories',
    'moderation_severity',
    'is_hidden',
    'flagged_at',
    'moderated_at',
    'moderated_by',
  ];

  for (const c of required) {
    if (cols.has(c)) ok(`${c} exists (${cols.get(c).data_type})`);
    else bad(`${c} MISSING — comment creation will fail`);
  }

  // is_hidden must not be nullable-with-no-default: the GET filter does
  // `is_hidden = false`, and NULL would silently drop every comment.
  const hidden = cols.get('is_hidden');
  if (hidden && hidden.is_nullable === 'NO') ok('is_hidden is NOT NULL (GET filter is safe)');
  else if (hidden) bad('is_hidden is nullable — NULL rows would vanish from the comment list');

  // ---------------------------------------------------------------
  section('2. New tables');
  // ---------------------------------------------------------------
  for (const t of ['moderation_words', 'moderation_actions']) {
    if (await tableExists(t)) ok(`${t} exists`);
    else bad(`${t} MISSING`);
  }

  // ---------------------------------------------------------------
  section('3. Indexes behind the queue query');
  // ---------------------------------------------------------------
  const commentIdx = (await indexNames('ticket_comments')).join(' ');
  // The moderation queue filters on status and orders by flagged_at. An
  // unindexed queue means a sequential scan of every comment ever posted.
  if (/moderation/i.test(commentIdx)) ok('ticket_comments has a moderation index');
  else bad('no moderation index on ticket_comments — the queue will seq-scan');

  // ---------------------------------------------------------------
  section('4. Status CHECK constraint');
  // ---------------------------------------------------------------
  // Proves the database itself rejects a bad status, so a bug in app code
  // cannot write a state the queue does not understand.
  try {
    await prisma.$executeRaw`
      UPDATE ticket_comments SET moderation_status = 'NOT_A_REAL_STATUS'
      WHERE id = '00000000-0000-0000-0000-000000000000'
    `;
    // Matching no rows is fine — we only care that the constraint exists.
    const chk = await prisma.$queryRaw`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'ticket_comments'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%moderation_status%'
    `;
    if (chk.length) ok('moderation_status CHECK constraint present');
    else bad('no CHECK on moderation_status — invalid states can be written');
  } catch (e) {
    // A throw here also proves the constraint is doing its job.
    if (/violates check constraint/i.test(e.message)) ok('moderation_status CHECK rejects bad values');
    else bad(`unexpected error probing CHECK: ${e.message.split('\n')[0]}`);
  }

  // ---------------------------------------------------------------
  section('5. Live round-trip: admin word applies without a restart');
  // ---------------------------------------------------------------
  // This is the requirement that cannot be proved by reading code.
  const probe = normaliseTerm('zzqq-moderation-probe');
  let created = null;

  try {
    // Baseline: the probe term must NOT match before it is added.
    invalidateWordCache();
    const before = analyseText(`a comment containing ${probe}`, {
      terms: await getActiveTerms({ force: true }),
      allowlist: ALLOWLIST,
    });
    if (!before.flagged) ok('probe term does not match before being added');
    else bad('probe term already matches — pick a different probe');

    created = await prisma.moderationWord.create({
      // `normalised` is the unique key that makes duplicate prevention
      // work, so it is required rather than optional. Every write path —
      // including the admin CRUD endpoints — must derive it with
      // normaliseTerm() rather than storing raw user input, or two
      // spellings of the same word could both be inserted.
      data: {
        term: probe,
        normalised: normaliseTerm(probe),
        category: 'HARASSMENT',
        severity: 'medium',
        isEnabled: true,
      },
    });
    ok('inserted a moderation word via Prisma');

    // The cache bust is what makes this immediate rather than TTL-delayed.
    invalidateWordCache();
    const after = analyseText(`a comment containing ${probe}`, {
      terms: await getActiveTerms({ force: true }),
      allowlist: ALLOWLIST,
    });

    if (after.flagged) ok('newly added word flags immediately — no redeploy, no restart');
    else bad('added word did NOT take effect — the no-redeploy requirement is unmet');

    // Disabling must stop it matching, or the enable/disable toggle is
    // decorative.
    await prisma.moderationWord.update({ where: { id: created.id }, data: { isEnabled: false } });
    invalidateWordCache();
    const disabled = analyseText(`a comment containing ${probe}`, {
      terms: await getActiveTerms({ force: true }),
      allowlist: ALLOWLIST,
    });
    if (!disabled.flagged) ok('disabling a word stops it matching');
    else bad('disabled word still matches — isEnabled is not honoured');
  } catch (e) {
    bad(`round-trip failed: ${e.message.split('\n')[0]}`);
  } finally {
    // Never leave test data behind in a real database.
    if (created) {
      await prisma.moderationWord.delete({ where: { id: created.id } }).catch(() => {});
      invalidateWordCache();
      console.log('  ....  probe word removed');
    }
  }

  // ---------------------------------------------------------------
  section('6. Audit trail is writable');
  // ---------------------------------------------------------------
  const anyComment = await prisma.ticketComment.findFirst({ select: { id: true } });
  if (!anyComment) {
    console.log('  SKIP  no comments in the database to attach an action to');
  } else {
    try {
      const action = await prisma.moderationAction.create({
        data: {
          commentId: anyComment.id,
          actorRole: 'SYSTEM',
          action: 'AUTO_FLAGGED',
          reason: 'verification probe',
          toStatus: 'PENDING',
        },
      });
      ok('moderation_actions accepts an audit row');
      await prisma.moderationAction.delete({ where: { id: action.id } });
      console.log('  ....  probe action removed');
    } catch (e) {
      bad(`cannot write audit trail: ${e.message.split('\n')[0]}`);
    }
  }

  // ---------------------------------------------------------------
  console.log(`\n${'='.repeat(52)}`);
  if (failures === 0) {
    console.log('RESULT: migration verified against the live database.');
  } else {
    console.log(`RESULT: ${failures} check(s) FAILED — see above.`);
  }
  console.log('='.repeat(52));

  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
};

run().catch(async (e) => {
  console.error('\nVerification crashed:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
