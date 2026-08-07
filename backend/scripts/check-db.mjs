/**
 * Verifies the database schema was applied correctly.
 *
 *   node scripts/check-db.mjs
 *
 * Uses the Supabase REST API, so it works even when the Postgres
 * pooler is unreachable from your network.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');

if (!fs.existsSync(envPath)) {
  console.error('❌ backend/.env not found');
  process.exit(1);
}

const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2];
}

const URL_ = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_ || !KEY) {
  console.error('❌ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from .env');
  process.exit(1);
}

const EXPECTED = [
  'profiles', 'departments', 'tickets', 'ticket_comments', 'ticket_events',
  'ticket_votes', 'ticket_attachments', 'notifications', 'push_subscriptions',
  'announcements', 'polls', 'poll_options', 'poll_votes',
  'saved_views', 'app_settings', 'audit_logs',
];

async function probe(table) {
  try {
    const res = await fetch(
      `${URL_}/rest/v1/${table}?select=*&limit=1`,
      {
        headers: {
          apikey: KEY,
          Authorization: `Bearer ${KEY}`,
          Prefer: 'count=exact',
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (res.ok) {
      const range = res.headers.get('content-range'); // "0-0/12"
      const count = range?.split('/')[1] ?? '?';
      return { ok: true, count };
    }
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.message || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

console.log(`Checking ${URL_}\n`);

let found = 0;
const missing = [];

for (const table of EXPECTED) {
  const r = await probe(table);
  if (r.ok) {
    found++;
    console.log(`  ✅ ${table.padEnd(20)} ${r.count} rows`);
  } else {
    missing.push(table);
    console.log(`  ❌ ${table.padEnd(20)} ${r.error}`);
  }
}

console.log(`\n${found}/${EXPECTED.length} tables present`);

if (missing.length === 0) {
  console.log('\n✅ Schema looks good.');

  const settings = await probe('app_settings');
  const depts = await probe('departments');
  if (depts.ok && depts.count === '0') {
    console.log('⚠️  departments is empty — 01_post_migration.sql may not have run');
  }
  if (settings.ok && settings.count === '0') {
    console.log('⚠️  app_settings is empty — 01_post_migration.sql may not have run');
  }
} else {
  console.log(`\n❌ Missing: ${missing.join(', ')}`);
  console.log('\nRun the SQL files in the Supabase SQL Editor, in this order:');
  console.log('  1. backend/prisma/sql/00_schema.sql');
  console.log('  2. backend/prisma/sql/01_post_migration.sql');
  process.exit(1);
}
