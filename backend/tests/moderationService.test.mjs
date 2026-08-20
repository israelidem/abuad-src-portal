/**
 * moderationService — verdict-to-column mapping and viewer visibility.
 *
 * The matcher itself is covered by textModeration.test.mjs. What is
 * tested here is the part that decides what a verdict *does*: which
 * status a comment lands in, whether it is hidden, and who is allowed to
 * see it afterwards. Those are the rules a bug would quietly break.
 *
 * No database. evaluateComment accepts a `terms` override precisely so
 * this mapping can be tested without one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateComment,
  canSeeHiddenComment,
  normaliseTerm,
  MODERATION_STATUS,
} from '../src/services/moderationService.js';

const TERMS = [
  { term: 'fuck', category: 'PROFANITY', severity: 'medium' },
  { term: 'kill yourself', category: 'THREAT', severity: 'high' },
  { term: 'damn', category: 'PROFANITY', severity: 'low' },
];

// ---------------------------------------------------------------
// Clean text
// ---------------------------------------------------------------

test('clean comment is APPROVED, not hidden, with no reason', async () => {
  const r = await evaluateComment('The lecture hall projector is broken.', { terms: TERMS });

  assert.equal(r.flagged, false);
  assert.equal(r.fields.moderationStatus, MODERATION_STATUS.APPROVED);
  assert.equal(r.fields.isHidden, false);
  assert.equal(r.fields.moderationReason, null);
  assert.equal(r.fields.flaggedAt, null);
});

test('empty and whitespace bodies do not flag', async () => {
  for (const body of ['', '   ', '\n\t']) {
    const r = await evaluateComment(body, { terms: TERMS });
    assert.equal(r.flagged, false, `"${body}" should not flag`);
  }
});

// ---------------------------------------------------------------
// Flagged text
// ---------------------------------------------------------------

test('abusive comment lands in PENDING and records why', async () => {
  const r = await evaluateComment('what the fuck is this', { terms: TERMS });

  assert.equal(r.flagged, true);
  assert.equal(r.fields.moderationStatus, MODERATION_STATUS.PENDING);
  assert.ok(r.fields.moderationReason, 'a reason must be recorded for the moderator');
  assert.ok(r.fields.moderationCategories.includes('PROFANITY'));
  assert.ok(r.fields.flaggedAt instanceof Date);
});

test('high-severity threat is hidden immediately; low-severity is queued but visible', async () => {
  const threat = await evaluateComment('kill yourself', { terms: TERMS });
  const mild = await evaluateComment('this damn door again', { terms: TERMS });

  // A credible threat should not sit publicly readable while it waits.
  assert.equal(threat.fields.isHidden, true, 'high severity must hide on sight');

  // Mild profanity in a real complaint must not be censored pre-review —
  // that is how a filter starts suppressing legitimate criticism.
  assert.equal(mild.fields.isHidden, false, 'low severity must stay visible pending review');
});

test('obfuscated abuse still reaches the queue through the service layer', async () => {
  // The engine handles the matching; this asserts the service does not
  // lose it on the way through.
  const r = await evaluateComment('f.u.c.k this', { terms: TERMS });
  assert.equal(r.flagged, true);
  assert.equal(r.fields.moderationStatus, MODERATION_STATUS.PENDING);
});

// ---------------------------------------------------------------
// Visibility of hidden comments
// ---------------------------------------------------------------

test('hidden comments are visible to staff and the author, nobody else', () => {
  const comment = { authorId: 'author-1' };

  assert.equal(canSeeHiddenComment(comment, { id: 'author-1', role: 'STUDENT' }), true);
  assert.equal(canSeeHiddenComment(comment, { id: 'x', role: 'REP' }), true);
  assert.equal(canSeeHiddenComment(comment, { id: 'x', role: 'ADMIN' }), true);
  assert.equal(canSeeHiddenComment(comment, { id: 'x', role: 'SUPER_ADMIN' }), true);

  // The cases that matter: another student, and a logged-out visitor.
  assert.equal(canSeeHiddenComment(comment, { id: 'other', role: 'STUDENT' }), false);
  assert.equal(canSeeHiddenComment(comment, null), false);
});

// ---------------------------------------------------------------
// Term normalisation
// ---------------------------------------------------------------

test('term normalisation collapses casing and spacing so duplicates cannot be stored', () => {
  const canonical = normaliseTerm('idiot');
  assert.equal(normaliseTerm('  IDIOT  '), canonical);
  assert.equal(normaliseTerm('Idiot'), canonical);
});
