/**
 * Settings / migration inspector.
 *
 *   node scripts/inspect-settings.mjs
 *
 * Reports the live shape of app_settings and the value of the singleton
 * row. Read-only — it issues no writes, so it is safe to run against any
 * environment, including production.
 *
 * Written because a migration run through the Supabase SQL editor failed
 * halfway (23502 on updated_at) and left it unclear whether the earlier
 * ALTERs had committed or been rolled back with the transaction. Guessing
 * that would have meant guessing whether the signup switch existed at
 * all; this asks the database instead.
 *
 * Exits non-zero if a column the application depends on is missing, so it
 * can be used as a post-deploy check.
 */

import { prisma } from '../src/lib/prisma.js';

/** Columns the app requires, and the migration that introduces each. */
const REQUIRED = {
  allow_student_signups: '07_signup_control.sql',
  signup_closed_message: '07_signup_control.sql',
  maintenance_mode: '04_phase4.sql',
  restrict_signup_domains: '01_post_migration.sql',
};

const main = async () => {
  const columns = await prisma.$queryRaw`
    select column_name, data_type, column_default, is_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = 'app_settings'
    order by ordinal_position
  `;

  if (!columns.length) {
    console.error('app_settings does not exist — has 00_schema.sql been run?');
    process.exit(1);
  }

  console.log('\napp_settings columns\n');
  console.table(
    columns.map((c) => ({
      column: c.column_name,
      type: c.data_type,
      default: c.column_default ?? '—',
      nullable: c.is_nullable,
    }))
  );

  const present = new Set(columns.map((c) => c.column_name));
  const missing = Object.entries(REQUIRED).filter(([name]) => !present.has(name));

  // `select *`, not a named column list. Naming columns here would make
  // this script fail with 42703 on exactly the drifted schema it exists
  // to report — which is what happened the first time it was run.
  const rows = await prisma.$queryRaw`
    select * from public.app_settings order by id
  `;

  console.log('\nsettings rows\n');
  if (rows.length) console.table(rows);
  else console.log('  (none — getSettings() will create id = 1 on first read)');

  // getSettings() catches read failures and returns DEFAULTS, so a drifted
  // schema does not take the API down — but it does mean the real domain
  // policy and maintenance flag are being ignored. Say so loudly.
  if (missing.length) {
    console.warn(
      '\nNOTE  Prisma selects every mapped column, so while these are absent\n' +
        '      getSettings() throws and falls back to DEFAULTS. The portal keeps\n' +
        '      working (signups open, maintenance off) but the stored domain\n' +
        '      policy is NOT being applied. Run the migration below.'
    );
  }

  // updated_at is NOT NULL with no DB default in the Prisma-generated
  // schema, which breaks any raw-SQL insert. Flag it rather than let the
  // next migration rediscover it the hard way.
  const updatedAt = columns.find((c) => c.column_name === 'updated_at');
  if (updatedAt && !updatedAt.column_default) {
    console.warn(
      '\nWARNING  updated_at is NOT NULL with no default. Raw-SQL inserts\n' +
        '         into this table will fail with 23502. Run 07_signup_control.sql,\n' +
        '         which sets `default now()`.'
    );
  }

  if (missing.length) {
    console.error('\nMISSING COLUMNS\n');
    for (const [name, migration] of missing) {
      console.error(`  ${name}  — run ${migration}`);
    }
    console.error('');
    process.exit(1);
  }

  console.log('\nAll required settings columns present.\n');
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
