/**
 * Portal feedback (§9) and portal ratings (§10).
 *
 * Three kinds of assertion here, for three kinds of risk:
 *
 *   1. Validator behaviour — real calls against the schemas. These are pure
 *      functions, so they can be tested properly rather than inspected.
 *
 *   2. Guard wiring — read from the registration source, following the
 *      technique established in adminUserCreation.test.mjs. Middleware
 *      returned by factories (`validateBody(schema)`, the limiters) is
 *      anonymous at runtime, so inspecting `handle.name` reports empty
 *      strings and cannot distinguish four real guards from four missing
 *      ones.
 *
 *   3. Schema/constraint agreement — the validator's category list against
 *      the SQL CHECK. This one exists because the mismatch was real: the
 *      first draft accepted 'TECHNICAL_ISSUE' while the constraint allowed
 *      'TECHNICAL', which would have passed validation and then thrown a
 *      500 from Postgres on a correctly filled form.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import feedbackRouter from '../src/routes/feedbackRoutes.js';
import {
  createFeedbackSchema,
  updateFeedbackSchema,
  listFeedbackSchema,
  submitRatingSchema,
  listRatingsSchema,
  FEEDBACK_CATEGORIES,
  FEEDBACK_STATUSES,
} from '../src/validators/feedbackSchemas.js';

// CRLF normalised on read — the repo checks out with Windows line endings,
// and the multi-line markers below silently fail to match without this.
const source = readFileSync(
  new URL('../src/routes/feedbackRoutes.js', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

const migration = readFileSync(
  new URL('../prisma/sql/11_feedback_and_ratings.sql', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

/** Removes comments so assertions test code, not prose. */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * The middleware list for one route — everything between the path literal
 * and the handler.
 */
const guardsFor = (method, pathLiteral) => {
  const marker = `router.${method}(\n  '${pathLiteral}',`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `could not locate ${method} ${pathLiteral}`);

  const rest = source.slice(start + marker.length);
  const end = rest.indexOf('\nrouter.');
  const route = end === -1 ? rest : rest.slice(0, end);

  const handlerAt = route.indexOf('asyncHandler(');
  assert.notEqual(handlerAt, -1, `${method} ${pathLiteral} has no asyncHandler`);
  return stripComments(route.slice(0, handlerAt));
};

// ------------------------------------------------------------
// Route registration
// ------------------------------------------------------------

describe('feedback router registration', () => {
  test('registers the eight expected routes', () => {
    const routes = feedbackRouter.stack
      .filter((l) => l.route)
      .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);

    for (const expected of [
      'POST /',
      'GET /mine',
      'GET /',
      'PATCH /:id',
      'GET /ratings/state',
      'POST /ratings',
      'GET /ratings/summary',
      'GET /ratings/list',
    ]) {
      assert.ok(routes.includes(expected), `missing route: ${expected}`);
    }
  });

  test('literal rating paths are registered before PATCH /:id', () => {
    /**
     * Ordering, not decoration.
     *
     * `PATCH /:id` only collides with a literal path on the same method, so
     * the GET/POST rating routes are safe either way — but if someone later
     * adds `PATCH /ratings/:id` below `PATCH /:id`, Express would match
     * ":id" = "ratings" and route a rating update into the feedback
     * handler. Pinning the current order makes that reordering visible.
     */
    const paths = feedbackRouter.stack.filter((l) => l.route).map((l) => l.route.path);
    assert.ok(
      paths.indexOf('/mine') < paths.indexOf('/:id'),
      '/mine must be registered before /:id',
    );
  });
});

// ------------------------------------------------------------
// Authorisation wiring
// ------------------------------------------------------------

describe('feedback authorisation', () => {
  test('admin list requires auth then admin', () => {
    const guards = guardsFor('get', '/');
    assert.match(guards, /requireAuth/);
    assert.match(guards, /requireAdmin/);
    assert.ok(
      guards.indexOf('requireAuth') < guards.indexOf('requireAdmin'),
      'requireAuth must run first so an anonymous caller gets 401, not 403',
    );
  });

  test('admin update requires auth, admin, and a write limiter', () => {
    const guards = guardsFor('patch', '/:id');
    assert.match(guards, /requireAuth/);
    assert.match(guards, /requireAdmin/);
    assert.match(guards, /adminWriteLimiter/);
    assert.match(guards, /validateBody\(updateFeedbackSchema\)/);
  });

  test('rating summary and list are admin-only', () => {
    for (const path of ['/ratings/summary', '/ratings/list']) {
      const guards = guardsFor('get', path);
      assert.match(guards, /requireAdmin/, `${path} must be admin-only`);
    }
  });

  test('user-facing routes require auth but not admin', () => {
    /**
     * The inverse assertion matters as much as the positive one: a
     * copy-paste that left requireAdmin on the submit route would lock
     * every student out of the feature, and the endpoint would still
     * return 201 in an admin's own testing.
     */
    for (const [method, path] of [
      ['post', '/'],
      ['get', '/mine'],
      ['post', '/ratings'],
      ['get', '/ratings/state'],
    ]) {
      const guards = guardsFor(method, path);
      assert.match(guards, /requireAuth/, `${method} ${path} must require auth`);
      assert.doesNotMatch(
        guards,
        /requireAdmin|requireSuperAdmin|requireStaff/,
        `${method} ${path} must not be staff-gated`,
      );
    }
  });

  test('both write paths are rate limited', () => {
    assert.match(guardsFor('post', '/'), /feedbackLimiter/);
    assert.match(guardsFor('post', '/ratings'), /feedbackLimiter/);
  });
});

// ------------------------------------------------------------
// Validator behaviour
// ------------------------------------------------------------

describe('createFeedbackSchema', () => {
  const valid = {
    category: 'BUG',
    subject: 'Star button does nothing',
    description: 'Tapping the fourth star on iOS Safari does not select it.',
  };

  test('accepts a well-formed report', () => {
    const result = createFeedbackSchema.safeParse(valid);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  test('rejects a whitespace-only subject', () => {
    /**
     * The reason `trimmed()` trims before length-checking. With a plain
     * min(5), "     " is five characters and lands in the admin queue as a
     * blank row.
     */
    const result = createFeedbackSchema.safeParse({ ...valid, subject: '        ' });
    assert.equal(result.success, false);
  });

  test('trims surrounding whitespace rather than storing it', () => {
    const result = createFeedbackSchema.safeParse({
      ...valid,
      subject: '  Star button does nothing  ',
    });
    assert.ok(result.success);
    assert.equal(result.data.subject, 'Star button does nothing');
  });

  test('rejects an over-long description', () => {
    const result = createFeedbackSchema.safeParse({
      ...valid,
      description: 'x'.repeat(4001),
    });
    assert.equal(result.success, false);
  });

  test('rejects an unknown category', () => {
    const result = createFeedbackSchema.safeParse({ ...valid, category: 'URGENT' });
    assert.equal(result.success, false);
  });

  test('rejects a screenshot reference that is not a bare public_id', () => {
    /**
     * These are the shapes that matter: a traversal segment, an absolute
     * URL, and a protocol-relative URL. Any of them stored and later
     * interpolated into a delivery URL would point somewhere unintended.
     */
    for (const bad of [
      'feedback/../../etc/passwd',
      'https://evil.example/x.png',
      '//evil.example/x.png',
      'feedback/has space',
      'feedback/<script>',
    ]) {
      const result = createFeedbackSchema.safeParse({ ...valid, screenshotPath: bad });
      assert.equal(result.success, false, `should have rejected: ${bad}`);
    }
  });

  test('accepts a normal Cloudinary public_id', () => {
    const result = createFeedbackSchema.safeParse({
      ...valid,
      screenshotPath: 'abuad-src/feedback/a1b2c3-screenshot_01',
    });
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });
});

describe('updateFeedbackSchema', () => {
  test('rejects an empty update', () => {
    const result = updateFeedbackSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test('accepts a status-only and a notes-only update', () => {
    assert.ok(updateFeedbackSchema.safeParse({ status: 'RESOLVED' }).success);
    assert.ok(updateFeedbackSchema.safeParse({ adminNotes: 'Duplicate.' }).success);
  });

  test('rejects an invented status', () => {
    assert.equal(updateFeedbackSchema.safeParse({ status: 'WONTFIX' }).success, false);
  });
});

describe('list pagination bounds', () => {
  test('feedback limit defaults to 20 and caps at 50', () => {
    assert.equal(listFeedbackSchema.parse({}).limit, 20);
    assert.equal(listFeedbackSchema.safeParse({ limit: '51' }).success, false);
    assert.equal(listFeedbackSchema.safeParse({ limit: '0' }).success, false);
  });

  test('ratings limit is bounded too', () => {
    assert.equal(listRatingsSchema.parse({}).limit, 20);
    assert.equal(listRatingsSchema.safeParse({ limit: '500' }).success, false);
  });

  test('a non-uuid cursor is rejected', () => {
    // The cursor reaches Prisma's `cursor: { id }`. Constraining it to a
    // uuid keeps malformed input at the validator instead of the database.
    assert.equal(listFeedbackSchema.safeParse({ cursor: 'not-a-uuid' }).success, false);
  });

  test('dismissals are excluded from the admin rating list by default', () => {
    assert.equal(listRatingsSchema.parse({}).includeDismissed, false);
    assert.equal(
      listRatingsSchema.parse({ includeDismissed: 'true' }).includeDismissed,
      true,
    );
  });
});

describe('submitRatingSchema', () => {
  test('accepts 1 through 5 stars', () => {
    for (const stars of [1, 2, 3, 4, 5]) {
      assert.ok(submitRatingSchema.safeParse({ stars }).success, `${stars} stars`);
    }
  });

  test('rejects out-of-range and fractional stars', () => {
    for (const stars of [0, 6, -1, 2.5, 999]) {
      assert.equal(
        submitRatingSchema.safeParse({ stars }).success,
        false,
        `should have rejected ${stars}`,
      );
    }
  });

  test('requires stars unless the prompt was dismissed', () => {
    assert.equal(submitRatingSchema.safeParse({}).success, false);
    assert.ok(submitRatingSchema.safeParse({ dismissed: true }).success);
  });

  test('rejects a dismissal that also carries stars', () => {
    /**
     * Mirrors portal_ratings_dismissed_consistency_check. Caught here the
     * caller gets a 400 explaining the contradiction; caught only by the
     * database it would be a 500.
     */
    const result = submitRatingSchema.safeParse({ dismissed: true, stars: 4 });
    assert.equal(result.success, false);
  });

  test('rejects an over-long reason', () => {
    const result = submitRatingSchema.safeParse({ stars: 2, reason: 'x'.repeat(1001) });
    assert.equal(result.success, false);
  });
});

// ------------------------------------------------------------
// Validator / database agreement
// ------------------------------------------------------------

describe('validators agree with the SQL constraints', () => {
  test('every category the API accepts is allowed by the CHECK constraint', () => {
    /**
     * This is the regression test for a bug that existed in the first
     * draft: the validator accepted 'TECHNICAL_ISSUE', the constraint
     * allowed 'TECHNICAL'. Nothing in the API layer could catch that — the
     * request validated cleanly and failed at the INSERT.
     */
    const checkStart = migration.indexOf('portal_feedback_category_check');
    assert.notEqual(checkStart, -1, 'category CHECK constraint not found in migration');
    const clause = migration.slice(checkStart, checkStart + 400);

    for (const category of FEEDBACK_CATEGORIES) {
      assert.ok(
        clause.includes(`'${category}'`),
        `validator accepts '${category}' but the CHECK constraint does not allow it`,
      );
    }
  });

  test('every status the API accepts is allowed by the CHECK constraint', () => {
    const checkStart = migration.indexOf('portal_feedback_status_check');
    assert.notEqual(checkStart, -1, 'status CHECK constraint not found in migration');
    const clause = migration.slice(checkStart, checkStart + 400);

    for (const status of FEEDBACK_STATUSES) {
      assert.ok(
        clause.includes(`'${status}'`),
        `validator accepts '${status}' but the CHECK constraint does not allow it`,
      );
    }
  });

  test('the description bound is no looser than the database allows', () => {
    /**
     * The API bound must be at or inside the database bound. If the API
     * allowed more than the CHECK, the extra characters would be rejected
     * by Postgres as a 500 rather than by Zod as a 400.
     */
    assert.match(migration, /char_length\(description\) between 10 and 4000/);
    assert.equal(
      createFeedbackSchema.safeParse({
        category: 'BUG',
        subject: 'Valid subject here',
        description: 'x'.repeat(4000),
      }).success,
      true,
      'API should accept exactly the database maximum',
    );
  });
});

// ------------------------------------------------------------
// Anti-abuse
// ------------------------------------------------------------

describe('anti-abuse behaviour is present in the handlers', () => {
  test('feedback submission enforces a database-backed daily cap', () => {
    const code = stripComments(source);
    assert.match(code, /portalFeedback\.count/, 'no daily-cap count query');
    assert.match(code, /recent >= 10/, 'daily cap threshold missing');
  });

  test('rating round is derived server-side, never from the request body', () => {
    const code = stripComments(source);
    // The round is what the unique index keys on. Taking it from the body
    // would let a script submit rounds 1..1000 and stuff the average.
    assert.match(code, /promptRound = \(latest\?\.promptRound \?\? 0\) \+ 1/);
    assert.doesNotMatch(
      code,
      /promptRound\s*[:=]\s*req\.body/,
      'promptRound must not come from the request body',
    );
  });

  test('the unique-violation race is translated to 409, not 500', () => {
    const code = stripComments(source);
    assert.match(code, /P2002/, 'unique violation not handled');
  });

  test('own-feedback responses exclude staff-only fields', () => {
    /**
     * OWN_FEEDBACK_FIELDS is an allowlist. Asserting the two sensitive
     * fields are absent means a later `adminNotes: true` added for
     * convenience fails here rather than leaking triage notes to reporters.
     */
    const start = source.indexOf('const OWN_FEEDBACK_FIELDS');
    const block = source.slice(start, source.indexOf('};', start));
    assert.doesNotMatch(block, /adminNotes/);
    assert.doesNotMatch(block, /resolvedBy/);
    assert.doesNotMatch(block, /userAgent/);
  });
});
