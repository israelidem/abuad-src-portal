/**
 * Route-mounting smoke test.
 *
 * Boots the Express app in-process with throwaway credentials and asserts
 * the v2 endpoints are actually mounted. It deliberately does NOT touch the
 * database: an unauthenticated request to a protected route is rejected by
 * requireAuth before any query runs.
 *
 * The distinction that matters is 404 vs 401.
 *   401 -> route exists, auth rejected us. Correct.
 *   404 -> route isn't mounted, i.e. stale/wrong code is running.
 *
 * Run: npm --prefix backend run smoke
 */

process.env.NODE_ENV ??= 'test';
process.env.PORT ??= '5099';
process.env.SUPABASE_URL ??= 'https://smoke.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'smoke-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'smoke-service-role-key';
process.env.DATABASE_URL ??= 'postgresql://u:p@127.0.0.1:6543/postgres';
process.env.ALLOWED_ORIGINS ??= 'http://localhost:5173';

await import('../server.js');

const base = `http://127.0.0.1:${process.env.PORT}`;

// server.js starts listening on import; give the socket a moment to bind.
await new Promise((resolve) => setTimeout(resolve, 500));

const cases = [
  { path: '/', expect: [200], note: 'root responds' },
  { path: '/health', expect: [200, 503], note: 'health route mounted (503 = no DB, fine)' },
  { path: '/api/auth/me', expect: [401], note: 'protected route mounted, not 404' },
  { path: '/api/auth/nope', expect: [404], note: 'unknown route still 404s' },
  {
    path: '/api/notifications',
    expect: [401],
    note: 'notification routes mounted, auth enforced',
  },
  {
    // Public by design, and reachable with no VAPID keys configured —
    // it reports enabled:false rather than erroring.
    path: '/api/notifications/vapid-public-key',
    expect: [200],
    note: 'vapid key endpoint public and degrades without keys',
  },
  {
    path: '/api/admin/moderation',
    expect: [401],
    note: 'moderation queue mounted, auth enforced',
  },
  {
    // Reveal is a POST; a GET must not quietly fall through to a 200.
    path: '/api/admin/tickets/00000000-0000-0000-0000-000000000000/reveal',
    expect: [404],
    note: 'author reveal is POST-only (GET does not expose it)',
  },
];

let failures = 0;

for (const { path, expect, note } of cases) {
  let status;
  try {
    status = (await fetch(`${base}${path}`)).status;
  } catch (err) {
    status = `fetch failed: ${err.message}`;
  }

  const ok = expect.includes(status);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${path.padEnd(20)} -> ${String(status).padEnd(4)} ` +
      `(expected ${expect.join('/')})  ${note}`
  );
}

/**
 * Schema guards — no database needed.
 *
 * Ticket creation broke because `ticket_number` was NOT NULL with no
 * default: the SQL defined next_ticket_number() but never attached it to
 * the column, and the API doesn't pass one. Prisma rejected every insert
 * with "Argument `ticketNumber` is missing".
 *
 * The fix has two halves that must stay in step, so check both.
 */
const { readFile } = await import('node:fs/promises');
const schemaUrl = new URL('../prisma/schema.prisma', import.meta.url);
const sqlUrl = new URL('../prisma/sql/01_post_migration.sql', import.meta.url);

const [schema, sql] = await Promise.all([
  readFile(schemaUrl, 'utf8'),
  readFile(sqlUrl, 'utf8'),
]);

const schemaChecks = [
  {
    ok: /ticketNumber\s+String[^\n]*@default\(dbgenerated\("public\.next_ticket_number\(\)"\)\)/.test(
      schema
    ),
    note: 'schema.prisma: ticketNumber has dbgenerated default (Prisma allows omitting it)',
  },
  {
    ok: /alter\s+column\s+ticket_number\s+set\s+default\s+public\.next_ticket_number\(\)/i.test(
      sql
    ),
    note: '01_post_migration.sql: ticket_number column default is attached (Postgres fills it)',
  },
];

for (const { ok, note } of schemaChecks) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${'[schema]'.padEnd(20)} -> ${'--'.padEnd(4)} ${note}`);
}

console.log(failures === 0 ? '\nSMOKE_OK' : `\nSMOKE_FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
