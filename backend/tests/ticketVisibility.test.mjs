/**
 * Ticket visibility & anonymity — buildWhere unit tests.
 *
 * These target buildWhere directly rather than going through HTTP. The
 * function is where every visibility decision is actually made, it's pure
 * (query + viewer in, Prisma filter out), and testing it needs no database,
 * no Supabase project and no seeded users — so this suite runs anywhere,
 * including CI without secrets.
 *
 * The cases below are the regressions from the audit. Each one failed
 * before this phase's changes.
 *
 * Run with:  npm test          (from backend/)
 *            node --test tests/
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildWhere, serialiseTicket } from '../src/services/ticketService.js';
import { listTicketsQuerySchema } from '../src/validators/ticketSchemas.js';

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

const STUDENT = { id: 'student-a', role: 'STUDENT' };
const OTHER_STUDENT = { id: 'student-b', role: 'STUDENT' };
const REP = { id: 'rep-1', role: 'REP' };
const ADMIN = { id: 'admin-1', role: 'ADMIN' };
const SUPER = { id: 'super-1', role: 'SUPER_ADMIN' };

/**
 * Runs a raw query string through the real Zod schema before buildWhere.
 *
 * This matters: the anonymous-ticket bug lived in the *gap* between what
 * the frontend sent and what the schema kept. Calling buildWhere with a
 * hand-built object would have hidden it, because the bug was that Zod
 * silently dropped `mine` and defaulted `includePrivate` to false. Parsing
 * first means these tests exercise the same path a real request takes.
 */
const parseAndBuild = (queryString, viewer) => {
  const params = Object.fromEntries(new URLSearchParams(queryString));
  const parsed = listTicketsQuerySchema.parse(params);
  return buildWhere(parsed, viewer);
};

/** Recursively looks for a filter clause matching a predicate. */
const findClause = (where, predicate) => {
  if (where == null || typeof where !== 'object') return false;
  if (predicate(where)) return true;
  return Object.values(where).some((value) =>
    Array.isArray(value)
      ? value.some((v) => findClause(v, predicate))
      : findClause(value, predicate)
  );
};

/** True if the filter constrains results to the public board. */
const restrictsToPublic = (where) =>
  findClause(where, (node) => node.isPublic === true && !('OR' in node));

// ------------------------------------------------------------
// The anonymous / private visibility regression (audit Phase 3)
// ------------------------------------------------------------

describe('staff visibility of private and anonymous tickets', () => {
  test('admin listing tickets is NOT restricted to the public board', () => {
    // The bug: includePrivate defaulted to false, so `isPublic: true` was
    // appended to every staff query and private submissions never appeared
    // on an admin screen.
    const where = parseAndBuild('', ADMIN);
    assert.equal(
      restrictsToPublic(where),
      false,
      'admin query must not filter out private tickets by default'
    );
  });

  for (const role of [REP, ADMIN, SUPER]) {
    test(`${role.role} sees private tickets by default`, () => {
      assert.equal(restrictsToPublic(parseAndBuild('', role)), false);
    });
  }

  test('staff can still opt in to a public-only view', () => {
    const where = parseAndBuild('includePrivate=false', ADMIN);
    assert.equal(
      restrictsToPublic(where),
      true,
      'includePrivate=false must narrow the view to the public board'
    );
  });

  test('the admin dashboard overdue queue is not restricted to public', () => {
    // The real admin dashboard request.
    const where = parseAndBuild('overdue=true&limit=10&sort=oldest', ADMIN);
    assert.equal(restrictsToPublic(where), false);
    assert.ok(
      findClause(where, (n) => n.dueAt && typeof n.dueAt === 'object' && 'lt' in n.dueAt),
      'overdue=true must add a dueAt filter'
    );
  });
});

// ------------------------------------------------------------
// Student visibility — the IDOR cases (audit Phase 2)
// ------------------------------------------------------------

describe('student visibility', () => {
  test('a student is confined to public tickets plus their own', () => {
    const where = parseAndBuild('', STUDENT);

    // Must carry an ownership escape hatch...
    assert.ok(
      findClause(where, (n) => n.authorId === STUDENT.id),
      'student filter must include their own tickets'
    );
    // ...and must never be a bare "everything" filter.
    assert.ok(
      findClause(where, (n) => n.isPublic === true),
      'student filter must constrain on isPublic'
    );
  });

  test('a student cannot widen their view with includePrivate=true', () => {
    // Privilege is decided by role, never by a query parameter. If this
    // ever fails, any student can read every private report in the portal.
    const attacker = parseAndBuild('includePrivate=true', STUDENT);
    const honest = parseAndBuild('', STUDENT);
    assert.deepEqual(
      attacker,
      honest,
      'includePrivate must be ignored for non-staff callers'
    );
  });

  test('a student cannot read another student by spoofing scope', () => {
    const where = parseAndBuild('scope=mine', STUDENT);
    assert.ok(
      findClause(where, (n) => n.authorId === STUDENT.id),
      'scope=mine must pin to the caller'
    );
    assert.equal(
      findClause(where, (n) => n.authorId === OTHER_STUDENT.id),
      false,
      'another user id must never appear in the filter'
    );
  });

  test('an anonymous (signed-out) caller sees only the public board', () => {
    const where = parseAndBuild('', null);
    assert.ok(findClause(where, (n) => n.isPublic === true && n.isFlagged === false));
    assert.equal(
      findClause(where, (n) => 'authorId' in n),
      false,
      'a signed-out caller has no ownership clause'
    );
  });

  test('scope=assigned is refused for students', () => {
    // A student must not be able to browse a staff queue.
    assert.throws(() => parseAndBuild('scope=assigned', STUDENT), /staff/i);
  });

  test('scope=mine is refused when signed out', () => {
    assert.throws(() => parseAndBuild('scope=mine', null), /Sign in/i);
  });
});

// ------------------------------------------------------------
// The `mine` alias (audit Phase 8 — wrong data, not just slow)
// ------------------------------------------------------------

describe('mine alias', () => {
  test('?mine=true pins the list to the caller', () => {
    // Before the fix Zod stripped `mine`, scope fell back to 'all', and
    // "My reports" listed the entire public board.
    const where = parseAndBuild('mine=true&limit=10&sort=newest', STUDENT);
    assert.ok(
      findClause(where, (n) => n.authorId === STUDENT.id),
      '?mine=true must filter to the caller'
    );
  });

  test('?mine=true and scope=mine agree', () => {
    assert.deepEqual(
      parseAndBuild('mine=true', STUDENT),
      parseAndBuild('scope=mine', STUDENT)
    );
  });

  test('an explicit scope wins over the alias', () => {
    const where = parseAndBuild('mine=true&scope=assigned', REP);
    assert.ok(findClause(where, (n) => n.assignedToId === REP.id));
  });

  test('a student sees their own anonymous tickets in "mine"', () => {
    // authorId is deliberately retained on anonymous rows so the student
    // keeps access to what they filed; anonymity is applied on output.
    const where = parseAndBuild('mine=true', STUDENT);
    assert.equal(
      findClause(where, (n) => n.isAnonymous === false),
      false,
      'anonymous tickets must not be excluded from the author\'s own list'
    );
  });
});

// ------------------------------------------------------------
// Anonymity on the way out (audit Phase 3 — privacy half)
// ------------------------------------------------------------

describe('serialiseTicket anonymity', () => {
  const anonymousTicket = {
    id: 't1',
    ticketNumber: 'SRC-000001',
    authorId: STUDENT.id,
    author: { id: STUDENT.id, fullName: 'Ada Lovelace', role: 'STUDENT' },
    isAnonymous: true,
    isPublic: true,
    isFlagged: false,
    status: 'PENDING',
    urgency: 'MEDIUM',
    category: 'WELFARE',
    description: 'Broken light in the hostel corridor.',
    locationText: 'Hostel B',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  test('the author identity is withheld from staff', () => {
    const result = serialiseTicket(anonymousTicket, ADMIN);
    assert.equal(result.author, null, 'staff must not receive the author object');
    assert.equal(result.hasHiddenAuthor, true, 'staff need the marker to label it');
  });

  test('no field in the staff payload leaks the author id', () => {
    // The stronger assertion: not just author, but nothing anywhere in the
    // response. A future field that quietly includes authorId fails here.
    const serialised = JSON.stringify(serialiseTicket(anonymousTicket, ADMIN));
    assert.equal(
      serialised.includes(STUDENT.id),
      false,
      'the anonymous author id must not appear anywhere in the payload'
    );
    assert.equal(serialised.includes('Ada Lovelace'), false);
  });

  test('another student learns nothing about the author', () => {
    const result = serialiseTicket(anonymousTicket, OTHER_STUDENT);
    assert.equal(result.author, null);
    assert.equal(result.isOwnTicket, false);
    assert.equal(
      result.hasHiddenAuthor,
      undefined,
      'the marker is a staff affordance, not public information'
    );
  });

  test('the author still recognises their own ticket', () => {
    // Otherwise a student cannot tell which anonymous report is theirs.
    const result = serialiseTicket(anonymousTicket, STUDENT);
    assert.equal(result.isOwnTicket, true);
    assert.ok(result.author, 'the author sees their own identity');
  });

  test('staff can still action an anonymous ticket', () => {
    // Anonymity must not cost the workflow: if canManage were false here,
    // an admin could see the report but not respond to it.
    const result = serialiseTicket(anonymousTicket, ADMIN);
    assert.equal(result.permissions.canManage, true);
    assert.equal(result.id, 't1');
    assert.equal(result.ticketNumber, 'SRC-000001');
    assert.equal(result.description, anonymousTicket.description);
  });

  test('a non-anonymous ticket still shows its author', () => {
    // Guards against over-correcting into hiding every author.
    const result = serialiseTicket(
      { ...anonymousTicket, isAnonymous: false },
      ADMIN
    );
    assert.ok(result.author);
    assert.equal(result.author.fullName, 'Ada Lovelace');
  });
});
