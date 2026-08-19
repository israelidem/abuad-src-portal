/**
 * Email / matric-number uniqueness — normalisation and duplicate reporting.
 *
 * Uniqueness has three layers, and these tests cover the two that are
 * testable without a live database:
 *
 *   1. Normalisation (here)     — canonical form, so the UNIQUE index and
 *                                 the pre-check compare like with like.
 *   2. Error mapping (here)     — the P2002 backstop produces copy a
 *                                 student can act on, without confirming
 *                                 whose account it is.
 *   3. UNIQUE indexes (SQL)     — verified by the queries at the end of
 *                                 06_security_hardening.sql.
 *
 * The pre-check in authRoutes is a courtesy, not the guarantee: two
 * simultaneous signups can both pass it. Layer 3 is what actually holds,
 * and layer 2 is what the loser of that race sees.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { signupSchema, updateProfileSchema } from '../src/validators/authSchemas.js';

const validSignup = {
  email: 'student@abuad.edu.ng',
  password: 'correct-horse-battery',
  fullName: 'Ada Lovelace',
};

describe('matric number normalisation', () => {
  // Every spelling a student might plausibly type for one matric number.
  // All must collapse to the same stored value, or the UNIQUE index sees
  // them as different people.
  const variants = [
    'CSC/19/1234',
    'csc/19/1234',
    'Csc/19/1234',
    '  CSC/19/1234  ',
    'CSC / 19 / 1234',
    'CSC/19/1234 ',
  ];

  for (const input of variants) {
    test(`"${input}" normalises to CSC/19/1234`, () => {
      const parsed = signupSchema.parse({ ...validSignup, matricNumber: input });
      assert.equal(parsed.matricNumber, 'CSC/19/1234');
    });
  }

  test('all variants collapse to exactly one canonical value', () => {
    const canonical = new Set(
      variants.map((v) => signupSchema.parse({ ...validSignup, matricNumber: v }).matricNumber)
    );
    assert.equal(
      canonical.size,
      1,
      `expected 1 canonical form, got ${[...canonical].join(', ')}`
    );
  });

  test('normalisation also applies on profile update', () => {
    // Otherwise a student registers with no matric number, then adds a
    // lowercase duplicate afterwards and sidesteps the signup check.
    const parsed = updateProfileSchema.parse({ matricNumber: ' csc/19/1234 ' });
    assert.equal(parsed.matricNumber, 'CSC/19/1234');
  });

  test('an empty matric number is still allowed', () => {
    // It's optional — staff accounts have none. This must not become a
    // required field by accident.
    assert.doesNotThrow(() => signupSchema.parse({ ...validSignup, matricNumber: '' }));
    assert.doesNotThrow(() => signupSchema.parse(validSignup));
  });

  test('an over-long matric number is rejected', () => {
    assert.throws(() =>
      signupSchema.parse({ ...validSignup, matricNumber: 'X'.repeat(41) })
    );
  });
});

describe('email normalisation', () => {
  test('case and surrounding whitespace are normalised', () => {
    const parsed = signupSchema.parse({ ...validSignup, email: '  Student@ABUAD.edu.NG ' });
    assert.equal(parsed.email, 'student@abuad.edu.ng');
  });

  test('a malformed email is rejected', () => {
    assert.throws(() => signupSchema.parse({ ...validSignup, email: 'not-an-email' }));
  });
});

describe('role cannot be set at signup', () => {
  test('a client-supplied role is stripped, not honoured', () => {
    // The first line of defence for the P0. Zod strips unknown keys, so
    // role never reaches Prisma even if the request body contains it.
    const parsed = signupSchema.parse({ ...validSignup, role: 'SUPER_ADMIN' });
    assert.equal(
      'role' in parsed,
      false,
      'role must never survive validation of a signup body'
    );
  });

  test('a client-supplied role is stripped on profile update too', () => {
    const parsed = updateProfileSchema.parse({ fullName: 'Ada L', role: 'ADMIN' });
    assert.equal('role' in parsed, false);
  });

  test('isActive cannot be set through profile update', () => {
    // Self-reactivating a suspended account would defeat moderation.
    const parsed = updateProfileSchema.parse({ fullName: 'Ada L', isActive: true });
    assert.equal('isActive' in parsed, false);
  });
});

// ------------------------------------------------------------
// The P2002 backstop
// ------------------------------------------------------------

describe('duplicate reporting via the error handler', () => {
  /**
   * Invokes the real error handler with a synthetic Prisma error and
   * captures the response. Lighter than booting Express, and it exercises
   * the exact branch a lost race would hit.
   */
  const runErrorHandler = async (err) => {
    const { errorHandler } = await import('../src/middleware/errorHandler.js');

    let status;
    let payload;
    const res = {
      status(code) {
        status = code;
        return this;
      },
      json(body) {
        payload = body;
        return this;
      },
    };

    errorHandler(err, { method: 'POST', originalUrl: '/api/auth/signup' }, res, () => {});
    return { status, payload };
  };

  const p2002 = (target) => ({
    code: 'P2002',
    meta: { target },
    message: 'Unique constraint failed',
  });

  test('a duplicate email returns 409 with actionable copy', async () => {
    const { status, payload } = await runErrorHandler(p2002(['email']));
    assert.equal(status, 409);
    assert.equal(payload.error, 'An account with this email already exists.');
  });

  test('a duplicate matric number returns 409 with actionable copy', async () => {
    const { status, payload } = await runErrorHandler(p2002(['matric_number']));
    assert.equal(status, 409);
    assert.equal(payload.error, 'This matriculation number is already registered.');
  });

  test('the raw column name never reaches the client', async () => {
    // Regression: this used to render as "That matric_number is already
    // in use.", exposing schema naming in user-facing copy.
    const { payload } = await runErrorHandler(p2002(['matric_number']));
    assert.equal(payload.error.includes('matric_number'), false);
    assert.equal(payload.error.includes('_'), false);
  });

  test('duplicate messages do not identify the other account', async () => {
    // Enumeration guard: revealing a name or email here would let an
    // attacker probe for who is registered.
    for (const target of [['email'], ['matric_number']]) {
      const { payload } = await runErrorHandler(p2002(target));
      assert.equal(payload.error.includes('@'), false);
      assert.match(payload.error, /already (exists|registered)/);
    }
  });

  test('an unmapped unique field still degrades to readable copy', async () => {
    const { status, payload } = await runErrorHandler(p2002(['ticket_number']));
    assert.equal(status, 409);
    assert.equal(payload.error, 'That ticket number is already in use.');
  });

  test('a non-array target is tolerated', async () => {
    // Prisma has reported meta.target as a bare string in some versions;
    // this must not throw a TypeError inside the error handler itself.
    const { status, payload } = await runErrorHandler(p2002('email'));
    assert.equal(status, 409);
    assert.equal(payload.error, 'An account with this email already exists.');
  });
});
