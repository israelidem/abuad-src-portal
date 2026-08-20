/**
 * Verifies observability against a running server.
 *
 * The unit tests cover the redaction rule and the audit diff in isolation.
 * What they cannot show is whether the middleware is actually wired into
 * the request path — a logger nobody calls passes every test it has.
 *
 * So this checks the observable contract from outside:
 *   - every response carries an X-Request-Id
 *   - an upstream id is honoured rather than replaced
 *   - error responses quote the id, so a student can report it
 *   - the audit endpoint is not readable without super-admin rights
 *
 * Usage:  npm run dev        (in one terminal)
 *         npm run verify:observability
 */

const BASE = process.env.API_URL ?? 'http://localhost:5000';

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

const main = async () => {
  console.log(`\nVerifying observability against ${BASE}\n`);

  // --- Request correlation ---------------------------------------------
  console.log('Request correlation');

  const health = await fetch(`${BASE}/health`);
  const generated = health.headers.get('x-request-id');

  check('a response carries X-Request-Id', Boolean(generated), 'header missing');
  check(
    'the generated id looks like a UUID',
    /^[0-9a-f-]{36}$/i.test(generated ?? ''),
    `got ${generated}`
  );

  // Two requests must not share an id, or correlation is meaningless.
  const second = await fetch(`${BASE}/health`);
  check(
    'each request gets a distinct id',
    second.headers.get('x-request-id') !== generated
  );

  // An id set by a proxy should be preserved so a trace spans both hops.
  const supplied = 'trace-from-upstream-123';
  const echoed = await fetch(`${BASE}/health`, { headers: { 'X-Request-Id': supplied } });
  check(
    'an upstream id is honoured, not replaced',
    echoed.headers.get('x-request-id') === supplied,
    `got ${echoed.headers.get('x-request-id')}`
  );

  // --- Errors are attributable -----------------------------------------
  console.log('\nError reporting');

  const notFound = await fetch(`${BASE}/api/definitely-not-a-route`);
  const notFoundBody = await notFound.json();

  check('a 404 is still correlated', Boolean(notFound.headers.get('x-request-id')));
  check(
    'the error body quotes the request id',
    typeof notFoundBody.requestId === 'string' && notFoundBody.requestId.length > 0,
    'client has nothing to quote when reporting the failure'
  );
  check(
    'the id in the body matches the header',
    notFoundBody.requestId === notFound.headers.get('x-request-id')
  );

  // --- Authorization on the new endpoint -------------------------------
  console.log('\nAudit trail authorization');

  const noToken = await fetch(`${BASE}/api/admin/audit`);
  check(
    'the audit trail rejects unauthenticated callers',
    noToken.status === 401,
    `expected 401, got ${noToken.status}`
  );

  const badToken = await fetch(`${BASE}/api/admin/audit`, {
    headers: { Authorization: 'Bearer not-a-real-token' },
  });
  check(
    'a forged token is rejected',
    badToken.status === 401,
    `expected 401, got ${badToken.status}`
  );

  // The trail names admins and can expose anonymous authors, so ADMIN is
  // not sufficient — only SUPER_ADMIN. Verified here as a 401/403, since
  // this script has no session to present.
  check(
    'the audit trail is never open',
    noToken.status !== 200 && badToken.status !== 200
  );

  // --- Secrets are not served ------------------------------------------
  console.log('\nSecret exposure');

  const publicSettings = await fetch(`${BASE}/api/admin/maintenance`);
  const settingsText = await publicSettings.text();

  // Cheap but worth keeping: the public settings payload grows over time,
  // and this is the endpoint most likely to accidentally gain a field.
  for (const forbidden of ['service_role', 'serviceRole', 'VAPID_PRIVATE', 'privateKey']) {
    check(
      `the public settings payload contains no "${forbidden}"`,
      !settingsText.includes(forbidden)
    );
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
};

main().catch((error) => {
  console.error(`\nCould not reach ${BASE} — is the server running?\n`);
  console.error(error.message);
  process.exit(1);
});
