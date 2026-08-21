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
  _maxActiveAdminTerms,
} from '../src/services/moderationService.js';
import { warmPatternCache } from '../src/lib/textModeration.js';

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

// ---------------------------------------------------------------
// Cost of the filter at the size the cap allows
//
// These exist because the cap is a performance decision, and a
// performance decision with no test is just a comment. The filter runs
// synchronously in the comment-submission request, so its cost is time
// Node spends serving nobody else.
//
// scripts/bench-moderation.mjs is the detailed instrument; these two
// guard the conclusion so a future change to the matcher cannot quietly
// undo it.
// ---------------------------------------------------------------

test('the admin term cap stays within the benchmarked-flat region', () => {
  const cap = _maxActiveAdminTerms();

  // Not an arbitrary range. Measured p99 was ~5ms at 200 terms and ~7ms at
  // 500, then 87-144ms at 1000. Anything at or above 1000 is outside the
  // region the benchmark found acceptable.
  assert.ok(cap >= 100, `cap ${cap} is too low to be useful for real moderation`);
  assert.ok(cap < 1000, `cap ${cap} reaches the size where p99 exceeded 87ms`);
});

test('STEADY STATE: a full-size word list scans a maximum-length comment within budget', async () => {
  const cap = _maxActiveAdminTerms();

  // Realistic shape: initials spread across the alphabet, as a genuine
  // blocklist is. Terms all sharing one initial defeat the engine's
  // first-letter prefilter and are not what real lists look like.
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const terms = Array.from({ length: cap }, (_, i) => ({
    term: `${alphabet[i % 26]}qx${i.toString(36)}term`,
    category: 'CUSTOM',
    severity: 'medium',
  }));

  // 2000 characters: the schema maximum for a comment body, so this is
  // the worst input a student can actually submit. Clean text is the
  // expensive case — nothing short-circuits, so every pattern runs to
  // completion before concluding "no match".
  const body = 'The hostel water supply has been broken for three weeks now. '.repeat(34).slice(0, 2000);

  // Warm up, so we time steady state rather than pattern compilation.
  //
  // NOTE: this warm-up is why this test alone is NOT sufficient, and the
  // name now says so. It passed at ~1-3ms while the first real comment
  // after a restart took 4782ms, because the discarded first call absorbed
  // all the compilation. The cold path is covered by the separate test
  // below; keep both.
  await evaluateComment(body, { terms });

  const started = process.hrtime.bigint();
  const runs = 20;
  for (let i = 0; i < runs; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await evaluateComment(body, { terms });
  }
  const meanMs = Number(process.hrtime.bigint() - started) / 1e6 / runs;

  // 25ms, not the 10ms the benchmark aims for. This runs on shared CI
  // and on whatever laptop happens to be busy, and a flaky performance
  // test gets deleted rather than investigated. The measured mean at this
  // size was ~1-3ms, so 25ms still fails loudly if the cost regresses by
  // an order of magnitude — which is the regression worth catching.
  assert.ok(
    meanMs < 25,
    `scanning a 2000-char comment against ${cap} terms took ${meanMs.toFixed(2)}ms on average; ` +
      'the filter blocks the event loop, so this is a latency regression for every request'
  );
});

test('COLD PATH: warming the cache makes the first scan of a fresh term set cheap', async () => {
  // The regression this test exists for: patterns compile lazily, at
  // ~29ms per term, and that cost landed inside comment submissions. The
  // steady-state test above cannot see it — it warms up first, which is
  // precisely how the problem survived a passing suite.
  //
  // Terms here are unique to this test so they cannot already be cached by
  // an earlier test in the same process. That is the whole point: a shared
  // fixture would be pre-warmed and this test would prove nothing.
  const terms = Array.from({ length: 60 }, (_, i) => ({
    term: `zcoldpath${i.toString(36)}word`,
    category: 'CUSTOM',
    severity: 'medium',
  }));

  const body = 'The hostel water supply has been broken for three weeks now. '.repeat(34).slice(0, 2000);

  // Warm explicitly, exactly as server.js does at boot.
  const stats = await warmPatternCache(terms);
  assert.equal(
    stats.compiled,
    terms.length,
    `warm-up compiled ${stats.compiled} of ${terms.length} terms — if this is 0, the cache key ` +
      'used by warmPatternCache no longer matches the one analyseText looks up, and the warm-up ' +
      'is silently useless'
  );
  assert.equal(stats.skipped, 0, 'no term should fail to compile');

  // Now the first scan. If warming works this is steady-state cost; if it
  // silently warmed the wrong keys, this pays full compilation.
  const started = process.hrtime.bigint();
  await evaluateComment(body, { terms });
  const firstMs = Number(process.hrtime.bigint() - started) / 1e6;

  // 60 terms would cost ~1700ms unwarmed (~29ms each, measured by
  // scripts/experiment-pattern-shape.mjs). Threshold is deliberately far
  // below that and far above steady state, so it distinguishes the two
  // without being flaky on a shared runner.
  assert.ok(
    firstMs < 250,
    `first scan after warm-up took ${firstMs.toFixed(1)}ms; unwarmed this would be ~1700ms, so ` +
      'the warm-up is not populating the cache the matcher actually reads'
  );
});
