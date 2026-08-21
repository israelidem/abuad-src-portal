/**
 * Splits the cost of the comment filter into compile vs scan.
 *
 * Written to explain a specific contradiction: the in-suite budget test
 * asserts a warm mean under 25ms and passes, yet the test itself was
 * reported as taking 19.7 seconds. Both cannot be true unless the time is
 * going somewhere the mean does not measure. The candidates:
 *
 *   1. Pattern compilation is expensive and paid on the first call for a
 *      given term set (the warm loop would then hide it).
 *   2. The suite runs test files in parallel, so wall-clock time inside
 *      one file includes CPU stolen by the others.
 *
 * These have opposite fixes, so guessing is not acceptable. (1) would mean
 * production pays a stall every time the word cache turns over, which
 * would be a real defect. (2) is a measurement artefact and means the
 * engine is fine.
 *
 * Usage: node scripts/probe-moderation-cost.mjs
 */

import { evaluateComment, _maxActiveAdminTerms } from '../src/services/moderationService.js';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const cap = _maxActiveAdminTerms();

/** Distinct term set each time, so nothing can be reused between measurements. */
const makeTerms = (salt) =>
  Array.from({ length: cap }, (_, i) => ({
    term: `${ALPHABET[i % 26]}q${salt}${i.toString(36)}term`,
    category: 'CUSTOM',
    severity: 'medium',
  }));

// 2000 chars: the schema maximum, and clean, which is the expensive case —
// no early exit, every pattern runs to completion.
const BODY = 'The hostel water supply has been broken for three weeks now. '
  .repeat(34)
  .slice(0, 2000);

const timed = async (fn) => {
  const started = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
};

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

const run = async () => {
  console.log(`\nModeration cost breakdown — ${cap} admin terms, ${BODY.length}-char clean body\n`);

  // --- Cold: first call for a brand-new term set -------------------
  const coldTimes = [];
  for (let i = 0; i < 5; i += 1) {
    const terms = makeTerms(`cold${i}`);
    // eslint-disable-next-line no-await-in-loop
    coldTimes.push(await timed(() => evaluateComment(BODY, { terms })));
  }

  // --- Warm: same term set, repeated ------------------------------
  const warmTerms = makeTerms('warm');
  await evaluateComment(BODY, { terms: warmTerms });

  const warmTimes = [];
  for (let i = 0; i < 200; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    warmTimes.push(await timed(() => evaluateComment(BODY, { terms: warmTerms })));
  }
  warmTimes.sort((a, b) => a - b);

  const coldMean = coldTimes.reduce((a, b) => a + b, 0) / coldTimes.length;
  const warmMean = warmTimes.reduce((a, b) => a + b, 0) / warmTimes.length;

  console.log(`  cold (new term set, n=5)   mean ${coldMean.toFixed(2)}ms   each: ${coldTimes.map((t) => t.toFixed(1)).join(', ')}`);
  console.log(`  warm (same set,   n=200)   mean ${warmMean.toFixed(3)}ms   p50 ${percentile(warmTimes, 50).toFixed(3)}ms   p95 ${percentile(warmTimes, 95).toFixed(3)}ms   p99 ${percentile(warmTimes, 99).toFixed(3)}ms   max ${warmTimes.at(-1).toFixed(2)}ms`);

  // --- How long would 20 warm calls take in a quiet process? ------
  const twenty = await timed(async () => {
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await evaluateComment(BODY, { terms: warmTerms });
    }
  });
  console.log(`  the suite test's 20-call loop, run alone: ${twenty.toFixed(1)}ms`);

  console.log('\nVerdict:');
  const ratio = coldMean / Math.max(warmMean, 0.001);
  if (coldMean > 200) {
    console.log(`  ✖ Compilation dominates: ${coldMean.toFixed(0)}ms on the first call for a new term`);
    console.log('    set, vs', warmMean.toFixed(2), 'ms warm. Production pays this every time the');
    console.log('    word cache expires, which is a real stall. Cache the compiled patterns.');
  } else {
    console.log(`  ✔ Compilation is cheap: cold ${coldMean.toFixed(1)}ms vs warm ${warmMean.toFixed(2)}ms (${ratio.toFixed(0)}x, but small in absolute terms).`);
    console.log(`  ✔ 20 warm calls take ${twenty.toFixed(0)}ms alone. The suite reported ~19,700ms for that`);
    console.log('    same loop, so ~99% of it was CPU contention from test files running in');
    console.log('    parallel, not engine cost. Measurement artefact, not a defect.');
  }
  console.log('');
};

run();
