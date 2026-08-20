/**
 * Observability tests.
 *
 * Two things here are worth asserting rather than eyeballing:
 *
 *   1. **Redaction.** The logger is now called with whole error objects and
 *      request context, so a regression in the key filter would quietly
 *      start writing bearer tokens to a log drain. That's a security bug
 *      with no visible symptom, which is exactly what a test is for.
 *
 *   2. **The audit diff.** `changes()` decides what an administrator sees
 *      when asking "what did this person change?". Getting "no changes" for
 *      a real change, or thirty noise fields for one edit, both make the
 *      trail useless.
 *
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testing, logger, securityLog } from '../src/lib/logger.js';
import { changes } from '../src/services/auditService.js';

// Keeps the runner's output readable. Set after the imports (which are
// hoisted) but before any test body runs — the level is read at write
// time, not at module load, so this takes effect.
process.env.LOG_LEVEL = 'silent';

const { sanitise, REDACTED, MAX_STRING } = __testing;

// ------------------------------------------------------------
// Redaction
// ------------------------------------------------------------

test('redacts credential-shaped keys regardless of case or nesting', () => {
  const out = sanitise({
    userId: 'safe-to-log',
    password: 'hunter2',
    accessToken: 'eyJhbGci...',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    headers: { Authorization: 'Bearer abc.def.ghi', 'x-request-id': 'keep-me' },
  });

  // The identifiers that make a log useful must survive.
  assert.equal(out.userId, 'safe-to-log');
  assert.equal(out.headers['x-request-id'], 'keep-me');

  // Everything credential-shaped must not.
  assert.equal(out.password, REDACTED);
  assert.equal(out.accessToken, REDACTED);
  assert.equal(out.SUPABASE_SERVICE_ROLE_KEY, REDACTED);
  assert.equal(out.headers.Authorization, REDACTED);
});

test('redacts push subscription fields, which identify a device', () => {
  // pushService logs against subscription ids for this reason; the filter
  // is the backstop if someone later logs the row itself.
  const out = sanitise({
    subscriptionId: 'row-123',
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: { p256dh: 'BNc...', auth: 'k9...' },
  });

  assert.equal(out.subscriptionId, 'row-123');
  assert.equal(out.endpoint, REDACTED);
  assert.equal(out.keys, REDACTED);
});

test('flattens Errors instead of dropping them to {}', () => {
  // JSON.stringify(new Error('x')) is '{}' — the failure mode that makes
  // "something went wrong" the only thing in a log file.
  const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'P1001' });
  const out = sanitise({ err });

  assert.equal(out.err.name, 'Error');
  assert.equal(out.err.message, 'connect ECONNREFUSED');
  assert.equal(out.err.code, 'P1001');
});

test('survives circular references', () => {
  // Express req/res and Prisma errors are both circular. A logger that
  // throws while logging an error is worse than no logger.
  const circular = { name: 'ticket' };
  circular.self = circular;

  assert.doesNotThrow(() => sanitise({ circular }));
  assert.equal(sanitise({ circular }).circular.self, '[circular]');
});

test('truncates long strings and caps long arrays', () => {
  const out = sanitise({
    body: 'x'.repeat(MAX_STRING + 50),
    recipients: Array.from({ length: 100 }, (_, i) => `user-${i}`),
  });

  assert.ok(out.body.endsWith('…[truncated]'));
  assert.ok(out.body.length < MAX_STRING + 50);

  // 20 kept + 1 summary line, so a campus-wide broadcast can't flood a log.
  assert.equal(out.recipients.length, 21);
  assert.equal(out.recipients.at(-1), '…80 more');
});

test('child loggers bind context without mutating the parent', () => {
  const child = logger.child({ requestId: 'req-1' });
  const grandchild = child.child({ userId: 'user-1' });

  // Mostly a shape check: routes call req.log.error(...) and a missing
  // method would only surface at the moment something else is failing.
  for (const level of ['debug', 'info', 'warn', 'error']) {
    assert.equal(typeof child[level], 'function');
    assert.equal(typeof grandchild[level], 'function');
  }

  assert.doesNotThrow(() => securityLog('forbidden', { userId: 'user-1' }));
});

// ------------------------------------------------------------
// Audit diff
// ------------------------------------------------------------

test('records only fields that actually changed', () => {
  const before = { allowStudentSignups: true, portalName: 'ABUAD SRC', maintenanceMode: false };
  const after = { allowStudentSignups: false, portalName: 'ABUAD SRC' };

  const diff = changes(before, after);

  // The one setting that moved, with both sides — the brief's
  // "previous value / new value" requirement.
  assert.deepEqual(diff, { allowStudentSignups: { from: true, to: false } });

  // Re-submitted-unchanged fields must not appear, or one real edit gets
  // buried in a form's worth of noise.
  assert.equal('portalName' in diff, false);
});

test('returns null when nothing changed', () => {
  // Lets a no-op re-save be told apart from a real change.
  assert.equal(changes({ maintenanceMode: true }, { maintenanceMode: true }), null);
});

test('never records identity or credential fields', () => {
  const diff = changes(
    { fullName: 'Old Name', matricNumber: 'OLD/123', password: 'a' },
    { fullName: 'New Name', matricNumber: 'NEW/456', password: 'b' }
  );

  assert.deepEqual(diff, { fullName: { from: 'Old Name', to: 'New Name' } });
  // A matric number in a readable audit row would deanonymise the student
  // behind an anonymous ticket.
  assert.equal('matricNumber' in diff, false);
  assert.equal('password' in diff, false);
});

test('treats a Date and its ISO string as equal', () => {
  const now = new Date();
  assert.equal(changes({ publishedAt: now }, { publishedAt: now.toISOString() }), null);
});
