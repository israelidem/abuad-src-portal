/**
 * POST /api/admin/users — manual account creation by a super admin.
 *
 * These assert the *wiring*, which is where this endpoint's risk actually
 * lives. The handler body is unremarkable; what makes it safe or unsafe is
 * which guard sits in front of it and which gates it deliberately skips.
 *
 * Both are the kind of thing a later refactor breaks silently — swapping
 * requireSuperAdmin for requireAdmin still returns 201 in every manual test
 * an admin would run, and only becomes privilege escalation in production.
 *
 * Note on technique: the first version of this file inspected
 * `layer.route.stack` and matched on `handle.name`. It reported
 * `requireAuth, , , ,` — every middleware after the first is a closure
 * returned by a factory (`validateBody(schema)`, the limiter) and carries no
 * name, so four real guards looked identical to four missing ones. Running
 * it is what exposed that; the assertions below read the registration source
 * instead, which is what a reviewer actually checks.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import adminRouter from '../src/routes/adminRoutes.js';

// Line endings normalised on read. Without this the multi-line markers below
// silently fail to match on Windows — the file is CRLF, the marker was LF, and
// the whole suite reported "could not locate post /users" for a route that was
// demonstrably registered.
const source = readFileSync(
  new URL('../src/routes/adminRoutes.js', import.meta.url),
  'utf8'
).replace(/\r\n/g, '\n');

/**
 * Source of one route registration, from its path literal to the next
 * `router.` at column 0.
 */
const routeSource = (method, pathLiteral) => {
  const marker = `router.${method}(\n  '${pathLiteral}',`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `could not locate ${method} ${pathLiteral}`);
  const rest = source.slice(start + marker.length);
  const end = rest.indexOf('\nrouter.');
  return end === -1 ? rest : rest.slice(0, end);
};

/**
 * The middleware list only — everything between the path and the handler.
 *
 * Keeping guards separate from the body matters: `requireAdmin` appears
 * legitimately in prose elsewhere in the file, and a test that searched the
 * whole route would pass or fail on a comment.
 */
const guardsFor = (method, pathLiteral) => {
  const route = routeSource(method, pathLiteral);
  const handlerAt = route.indexOf('asyncHandler(');
  assert.notEqual(handlerAt, -1, 'route has no asyncHandler');
  return stripComments(route.slice(0, handlerAt));
};

/** Removes // and /* comments, so assertions test code and not prose. */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('POST /api/admin/users', () => {
  test('is registered on the router', () => {
    // The one thing worth checking against the live router rather than the
    // text: that Express actually mounted it.
    const layer = adminRouter.stack.find(
      (l) => l.route?.path === '/users' && l.route?.methods?.post
    );
    assert.ok(layer, 'POST /users is not registered');
  });

  test('requires super admin, not merely admin', () => {
    const guards = guardsFor('post', '/users');

    // The load-bearing assertion. This endpoint can mint a SUPER_ADMIN, so
    // exposing it to ADMIN would let any admin promote themselves by
    // creating a second account — privilege escalation through a feature
    // whose stated purpose is routine onboarding.
    assert.match(guards, /requireSuperAdmin/);
    assert.ok(
      !/requireAdmin\b/.test(guards),
      'requireAdmin must not guard an endpoint that can create a super admin'
    );
  });

  test('authenticates before authorising', () => {
    const guards = guardsFor('post', '/users');
    // A role guard placed before requireAuth reads req.user before anything
    // populates it, which throws — or, worse, waves the request through.
    assert.ok(
      guards.indexOf('requireAuth') < guards.indexOf('requireSuperAdmin'),
      'requireAuth must run before the role guard'
    );
  });

  test('is rate limited', () => {
    // A stolen super-admin session should not be able to mint accounts in a
    // loop faster than anyone can notice.
    assert.match(guardsFor('post', '/users'), /adminWriteLimiter/);
  });

  test('validates the body against a schema', () => {
    assert.match(guardsFor('post', '/users'), /validateBody\(createUserSchema\)/);
  });
});

describe('manual creation ignores the public signup gate', () => {
  const route = stripComments(routeSource('post', '/users'));

  /**
   * The actual requirement from the brief: this must keep working when
   * public registration is closed.
   *
   * Asserted by absence rather than by a live call, because the failure mode
   * is someone "tidying up" by adding the same guard the public route has —
   * at which point the feature silently stops doing the one thing it exists
   * for, and only while signups happen to be closed.
   */
  test('does not consult checkSignupAllowed', () => {
    assert.ok(
      !route.includes('checkSignupAllowed'),
      'the signup gate must not apply here — the feature exists for when it is shut'
    );
  });

  test('does not enforce the email domain allow-list', () => {
    // Domain restriction polices self-service registration by strangers. A
    // super admin onboarding an external guest lecturer is a judgement they
    // are trusted to make.
    assert.ok(!route.includes('checkEmailDomain'));
  });
});

describe('response hygiene and ordering', () => {
  const route = stripComments(routeSource('post', '/users'));

  test('never selects the password into the response', () => {
    // It would land in devtools, any intermediary proxy log, and the
    // response cache. The caller already knows it; nobody else should.
    //
    // Comments are stripped first — the previous version of this assertion
    // failed on the word "password" inside its own explanatory comment.
    const select = route.slice(route.indexOf('select:'));
    assert.ok(!/password/i.test(select), 'password must not be a selected field');
  });

  test('does not return the raw Supabase user object', () => {
    // `data.user` carries auth internals — app_metadata, identities,
    // confirmation tokens. The response is built from a narrow profile
    // select instead.
    assert.ok(!/json\(\{\s*user:\s*data\.user/.test(route));
  });

  test('writes an audit row naming the creator', () => {
    // Manual creation of a privileged account is precisely the event an
    // audit trail exists to answer for.
    assert.match(route, /'user\.created_by_admin'/);
  });

  test('checks the matric number before creating the auth user', () => {
    // Ordering, not presence. Detecting the clash afterwards leaves an
    // orphaned auth user, and the corrected retry then fails with "email
    // already registered" — a dead end for whoever is being onboarded.
    const clash = route.indexOf('findUnique({ where: { matricNumber } })');
    const create = route.indexOf('auth.admin.createUser');
    assert.ok(clash !== -1, 'no matric duplicate check found');
    assert.ok(create !== -1, 'no auth user creation found');
    assert.ok(clash < create, 'duplicate check must precede auth user creation');
  });

  test('maps a duplicate email to 409 rather than a raw auth error', () => {
    // Supabase phrases this as prose. Surfacing it unmapped would give the
    // admin a 400 for what is really a conflict.
    assert.match(route, /already registered/);
    assert.match(route, /ApiError\(409/);
  });
});
