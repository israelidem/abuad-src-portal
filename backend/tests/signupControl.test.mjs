/**
 * Phase 5 — registration control.
 *
 * The switch has to hold at the API, not in React, so these tests target
 * the decision function the signup route actually calls plus the schema
 * that guards the admin endpoint. Neither needs a database.
 *
 * What is covered here:
 *   - the gate opens/closes on the flag
 *   - closing it produces copy a student can act on
 *   - a missing flag fails OPEN (pre-migration API, or a failed read)
 *   - the admin schema accepts the new fields and rejects junk
 *
 * What is NOT covered here (needs the live instance):
 *   - that app_settings is SUPER_ADMIN-only via RLS
 *   - that `anon` cannot INSERT into profiles
 *   Both are asserted by the verification queries in 07_signup_control.sql.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkSignupAllowed,
  DEFAULT_CLOSED_MESSAGE,
} from '../src/services/registrationPolicy.js';
import { settingsSchema } from '../src/validators/settingsSchemas.js';

describe('the signup gate', () => {
  test('signups open when the flag is on', () => {
    const { allowed, reason } = checkSignupAllowed({ allowStudentSignups: true });
    assert.equal(allowed, true);
    assert.equal(reason, null, 'an open gate must not carry a rejection message');
  });

  test('signups closed when the flag is off', () => {
    const { allowed } = checkSignupAllowed({ allowStudentSignups: false });
    assert.equal(allowed, false);
  });

  test('closing the gate always explains itself', () => {
    const { reason } = checkSignupAllowed({ allowStudentSignups: false });
    assert.equal(reason, DEFAULT_CLOSED_MESSAGE);
    assert.match(reason, /contact the SRC/i, 'the student needs a next step');
  });

  test("an admin's custom message replaces the default", () => {
    const { reason } = checkSignupAllowed({
      allowStudentSignups: false,
      signupClosedMessage: 'Registration reopens on 1 October.',
    });
    assert.equal(reason, 'Registration reopens on 1 October.');
  });

  test('a blank custom message falls back rather than showing nothing', () => {
    for (const blank of ['', '   ', '\n\t']) {
      const { reason } = checkSignupAllowed({
        allowStudentSignups: false,
        signupClosedMessage: blank,
      });
      assert.equal(reason, DEFAULT_CLOSED_MESSAGE, `blank "${blank}" should fall back`);
    }
  });
});

describe('the gate fails open', () => {
  // A closed-by-accident gate is an invisible outage: every new student is
  // turned away and nothing in the portal looks broken. Open-by-accident is
  // recoverable — the admin flips the switch again.
  const degraded = [
    ['the settings read returned nothing', undefined],
    ['the settings read returned null', null],
    ['the row exists but predates the migration', { maintenanceMode: false }],
    ['the field is explicitly undefined', { allowStudentSignups: undefined }],
  ];

  for (const [scenario, settings] of degraded) {
    test(`${scenario} → signups stay open`, () => {
      const { allowed } = checkSignupAllowed(settings);
      assert.equal(allowed, true);
    });
  }

  test('only an explicit false closes registration', () => {
    assert.equal(checkSignupAllowed({ allowStudentSignups: false }).allowed, false);
    // Truthy-ish values must not be read as "closed".
    assert.equal(checkSignupAllowed({ allowStudentSignups: true }).allowed, true);
  });
});

describe('the admin settings schema', () => {
  test('accepts the registration fields', () => {
    const parsed = settingsSchema.parse({
      allowStudentSignups: false,
      signupClosedMessage: '  Back in October.  ',
    });
    assert.equal(parsed.allowStudentSignups, false);
    assert.equal(parsed.signupClosedMessage, 'Back in October.', 'should be trimmed');
  });

  test('null clears a custom message', () => {
    const parsed = settingsSchema.parse({ signupClosedMessage: null });
    assert.equal(parsed.signupClosedMessage, null);
  });

  test('the toggle must be a boolean, not a string', () => {
    // Guards against a form sending "false", which is truthy in JS and
    // would flip the gate the wrong way.
    assert.throws(() => settingsSchema.parse({ allowStudentSignups: 'false' }));
  });

  test('an over-long message is rejected', () => {
    assert.throws(() => settingsSchema.parse({ signupClosedMessage: 'x'.repeat(301) }));
  });

  test('an empty patch is rejected', () => {
    assert.throws(() => settingsSchema.parse({}), /No changes supplied/);
  });

  test('an unknown key is rejected rather than silently dropped', () => {
    assert.throws(() => settingsSchema.parse({ role: 'SUPER_ADMIN' }));
  });

  test('existing settings still validate alongside the new ones', () => {
    const parsed = settingsSchema.parse({
      maintenanceMode: true,
      allowStudentSignups: false,
      restrictSignupDomains: true,
      allowedDomains: ['ABUAD.EDU.NG'],
    });
    assert.equal(parsed.maintenanceMode, true);
    assert.equal(parsed.allowStudentSignups, false);
    assert.deepEqual(parsed.allowedDomains, ['abuad.edu.ng'], 'domains lowercase');
  });
});
