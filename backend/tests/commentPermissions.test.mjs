/**
 * Comment permissions — the resolved lock (requirement 1) and the
 * 30-minute deletion window (requirement 5).
 *
 * WHY THESE ARE UNIT TESTS OF THE GATE FUNCTIONS
 * ------------------------------------------------------------
 * The route handlers call exactly these two functions, and
 * `serialiseTicket` derives `permissions.canComment` / `canDelete` from the
 * same pair. Testing them therefore covers the UI and the API in one place
 * and — more to the point — pins the property that matters: the frontend
 * cannot disagree with the server, because there is only one rule.
 *
 * What is deliberately *not* mocked: the clock. `canDeleteComment` takes
 * `now` as an argument precisely so the boundary can be tested exactly
 * rather than approximately, and so production code never reads
 * `Date.now()` at two different moments within one decision.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMENTS_LOCKED_STATUSES,
  areCommentsLocked,
  canCommentOnTicket,
  COMMENT_DELETE_WINDOW_MS,
  commentDeleteMsRemaining,
  canDeleteComment,
} from '../src/services/ticketService.js';

const student = { id: 'student-1', role: 'STUDENT' };
const otherStudent = { id: 'student-2', role: 'STUDENT' };
const rep = { id: 'rep-1', role: 'REP' };
const admin = { id: 'admin-1', role: 'ADMIN' };
const superAdmin = { id: 'sa-1', role: 'SUPER_ADMIN' };
const dev = { id: 'dev-1', role: 'DEV' };

/** Every status the ticket lifecycle can be in. */
const ALL_STATUSES = ['PENDING', 'IN_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REJECTED'];

// ------------------------------------------------------------
// Requirement 1: comments close when the report is resolved
// ------------------------------------------------------------

describe('the resolved comment lock', () => {
  test('the lock is tied to status, not to an arbitrary flag', () => {
    // The brief asks for the behaviour to key off the resolved/closed
    // state specifically. Asserting the constant keeps a later "just add
    // REJECTED here" from silently changing the product rule.
    assert.deepEqual(COMMENTS_LOCKED_STATUSES, ['RESOLVED', 'CLOSED']);
  });

  test('RESOLVED locks the discussion', () => {
    assert.equal(areCommentsLocked({ status: 'RESOLVED' }), true);
  });

  test('CLOSED locks the discussion', () => {
    // CLOSED is included because a closed report is no longer an open
    // conversation either; leaving it unlocked would be the same bug in a
    // different status.
    assert.equal(areCommentsLocked({ status: 'CLOSED' }), true);
  });

  test('every other status leaves it open', () => {
    for (const status of ALL_STATUSES.filter((s) => !COMMENTS_LOCKED_STATUSES.includes(s))) {
      assert.equal(
        areCommentsLocked({ status }),
        false,
        `${status} must not lock comments`
      );
    }
  });

  test('a missing or unknown status does not lock anything', () => {
    // Fail open: a ticket shape we do not recognise must not silently
    // freeze a live discussion.
    assert.equal(areCommentsLocked(undefined), false);
    assert.equal(areCommentsLocked({}), false);
    assert.equal(areCommentsLocked({ status: 'SOMETHING_NEW' }), false);
  });

  test('a student cannot comment once the report is resolved', () => {
    const gate = canCommentOnTicket({ status: 'RESOLVED' }, student);
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /resolved/i);
  });

  test('the refusal explains itself in the student\u2019s terms', () => {
    // The reason string is what the UI renders and what the 409 body
    // carries, so it has to read as an explanation rather than an error.
    const resolved = canCommentOnTicket({ status: 'RESOLVED' }, student);
    const closed = canCommentOnTicket({ status: 'CLOSED' }, student);
    assert.match(resolved.reason, /comments are now closed/i);
    assert.match(closed.reason, /comments are now closed/i);
    // And they are distinguishable — a resolved report is not a closed one.
    assert.notEqual(resolved.reason, closed.reason);
  });

  test('a student can still comment while the report is open', () => {
    for (const status of ['PENDING', 'IN_REVIEW', 'IN_PROGRESS']) {
      assert.equal(canCommentOnTicket({ status }, student).allowed, true, status);
    }
  });

  test('staff keep commenting after resolution', () => {
    // Existing behaviour, preserved on purpose: an admin adding a
    // follow-up note to a resolved report is a normal moderation action,
    // and the brief says not to change staff permissions.
    for (const staff of [rep, admin, superAdmin, dev]) {
      const gate = canCommentOnTicket({ status: 'RESOLVED' }, staff);
      assert.equal(gate.allowed, true, `${staff.role} must keep commenting`);
      assert.equal(gate.reason, null);
    }
  });

  test('an anonymous caller is refused before status is considered', () => {
    const gate = canCommentOnTicket({ status: 'PENDING' }, null);
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /sign in/i);
  });
});

// ------------------------------------------------------------
// Requirement 5: the 30-minute deletion window
// ------------------------------------------------------------

describe('the comment deletion window', () => {
  const WINDOW = COMMENT_DELETE_WINDOW_MS;

  /** A comment authored by `student`, created `msAgo` before `now`. */
  const commentAgedBy = (msAgo, now) => ({
    id: 'comment-1',
    authorId: student.id,
    createdAt: new Date(now.getTime() - msAgo).toISOString(),
  });

  const now = new Date('2026-03-01T12:00:00.000Z');

  test('the window is exactly 30 minutes', () => {
    assert.equal(WINDOW, 30 * 60 * 1000);
  });

  test('a fresh comment can be deleted by its author', () => {
    const gate = canDeleteComment(commentAgedBy(0, now), student, now);
    assert.equal(gate.allowed, true);
    assert.equal(gate.isModeration, false);
  });

  test('a comment 29:59 old can still be deleted', () => {
    const gate = canDeleteComment(commentAgedBy(WINDOW - 1000, now), student, now);
    assert.equal(gate.allowed, true);
  });

  test('a comment 30:01 old cannot', () => {
    const gate = canDeleteComment(commentAgedBy(WINDOW + 1000, now), student, now);
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /30-minute window/i);
  });

  test('the boundary itself is closed, not open', () => {
    // Exactly 30:00.000 elapsed. `<= 0` on the remaining time makes this a
    // refusal, which is the safe side of a race: the alternative lets a
    // request that arrives on the tick through.
    const gate = canDeleteComment(commentAgedBy(WINDOW, now), student, now);
    assert.equal(gate.allowed, false, 'the instant the window closes must refuse');
  });

  test('remaining time counts down and floors at zero', () => {
    assert.equal(commentDeleteMsRemaining(commentAgedBy(0, now), now), WINDOW);
    assert.equal(commentDeleteMsRemaining(commentAgedBy(WINDOW / 2, now), now), WINDOW / 2);
    assert.equal(commentDeleteMsRemaining(commentAgedBy(WINDOW, now), now), 0);
    // Never negative — the countdown in the UI formats this directly.
    assert.equal(commentDeleteMsRemaining(commentAgedBy(WINDOW * 10, now), now), 0);
  });

  test('a student cannot delete another student\u2019s comment', () => {
    const gate = canDeleteComment(commentAgedBy(0, now), otherStudent, now);
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /only delete your own/i);
  });

  test('ownership is checked before the clock', () => {
    // Otherwise the error message leaks whether somebody else's comment is
    // recent, and a student learns the wrong lesson about why they were
    // refused.
    const stale = commentAgedBy(WINDOW * 2, now);
    const gate = canDeleteComment({ ...stale, authorId: otherStudent.id }, student, now);
    assert.match(gate.reason, /only delete your own/i);
  });

  test('staff deletion is moderation and is not time-limited', () => {
    // The existing moderation rules stay as they were: an admin removing
    // an abusive comment a week later must still work, and it is flagged
    // as moderation so the audit trail can tell the two apart.
    const old = commentAgedBy(WINDOW * 100, now);
    for (const staff of [rep, admin, superAdmin, dev]) {
      const gate = canDeleteComment(old, staff, now);
      assert.equal(gate.allowed, true, `${staff.role} must retain moderation`);
      assert.equal(gate.isModeration, true);
    }
  });

  test('a student deleting their own comment is not marked as moderation', () => {
    // The distinction drives what the activity trail records; conflating
    // them would report every self-delete as a moderator action.
    const gate = canDeleteComment(commentAgedBy(60_000, now), student, now);
    assert.equal(gate.isModeration, false);
  });

  test('an anonymous caller is refused', () => {
    const gate = canDeleteComment(commentAgedBy(0, now), null, now);
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /sign in/i);
  });

  test('a client cannot widen the window by forging a timestamp', () => {
    /*
     * The bypass this closes: the DELETE body/params carry no timestamp,
     * and the gate reads `createdAt` from the row Prisma returned. Here we
     * simulate the attempt — a comment whose *stored* createdAt is two
     * hours old, which a crafted request claims is fresh. The function has
     * no channel through which that claim could arrive, so the only input
     * is the stored value, and it refuses.
     */
    const stored = commentAgedBy(WINDOW * 4, now);
    const forged = { ...stored, clientCreatedAt: now.toISOString(), age: 0 };
    assert.equal(canDeleteComment(forged, student, now).allowed, false);
  });

  test('timezone representation of the same instant does not change the answer', () => {
    // createdAt arrives as an ISO string from Prisma; a +01:00 rendering of
    // the same moment must be treated identically, or the window silently
    // shifts by the offset for anyone stored in local time.
    const utc = { authorId: student.id, createdAt: '2026-03-01T11:45:00.000Z' };
    const offset = { authorId: student.id, createdAt: '2026-03-01T12:45:00.000+01:00' };
    assert.equal(
      commentDeleteMsRemaining(utc, now),
      commentDeleteMsRemaining(offset, now),
      'the same instant in two notations must yield the same remaining time'
    );
    // 15 minutes in, so both still deletable.
    assert.equal(canDeleteComment(utc, student, now).allowed, true);
    assert.equal(canDeleteComment(offset, student, now).allowed, true);
  });

  test('a Date object and its ISO string behave the same', () => {
    // Prisma returns Date; the serialised API response carries a string.
    const asDate = { authorId: student.id, createdAt: new Date(now.getTime() - 60_000) };
    const asString = { authorId: student.id, createdAt: asDate.createdAt.toISOString() };
    assert.equal(
      commentDeleteMsRemaining(asDate, now),
      commentDeleteMsRemaining(asString, now)
    );
  });
});
