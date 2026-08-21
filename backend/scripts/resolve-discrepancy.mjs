/**
 * Resolves the 4.5x disagreement between my two moderation benchmarks.
 *
 * Same process, same terms, same body. Four cells:
 *
 *              tight loop        await loop
 *   analyseText     A                B
 *   evaluateComment C                D
 *
 * If A≈C and B≈D but A≠B, the entry point is irrelevant and the `await`
 * is what changes the number — i.e. my capacity figure was a measurement
 * artefact, not a property of the code.
 *
 * If A≈B but C≈D and they differ, the service layer is doing less work
 * than analyseText, and I need to find out what it skips.
 *
 * Run: node scripts/resolve-discrepancy.mjs
 */

import { analyseText } from '../src/lib/textModeration.js';
import { evaluateComment, _maxActiveAdminTerms } from '../src/services/moderationService.js';
import { BUILTIN_WORDLIST, ALLOWLIST } from '../src/config/moderationWordlist.js';

const cap = _maxActiveAdminTerms();
const terms = [...BUILTIN_WORDLIST];
for (let i = terms.length; i < cap; i += 1) {
  terms.push({ term: `custom phrase ${i.toString(36)}`, category: 'CUSTOM', severity: 'medium' });
}

const body =
  'The quick brown fox jumps over the lazy dog while every student waits for the bursary payment to be approved by the finance office and nobody explains the delay. '.repeat(
    12
  ).slice(0, 2000);

// Warm both paths and the pattern cache thoroughly before any timing.
for (let i = 0; i < 30; i += 1) {
  analyseText(body, { terms, allowlist: ALLOWLIST });
  // eslint-disable-next-line no-await-in-loop
  await evaluateComment(body, { terms });
}

const RUNS = 300;

const tight = (fn) => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < RUNS; i += 1) fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / RUNS;
};

const awaited = async (fn) => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < RUNS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await fn();
  }
  return Number(process.hrtime.bigint() - t0) / 1e6 / RUNS;
};

// A: analyseText, tight
const A = tight(() => analyseText(body, { terms, allowlist: ALLOWLIST }));
// B: analyseText, awaited (await on an already-resolved value still yields)
const B = await awaited(async () => analyseText(body, { terms, allowlist: ALLOWLIST }));
// C: evaluateComment, "tight" — fire without awaiting, then settle
const C = tight(() => {
  void evaluateComment(body, { terms });
});
// D: evaluateComment, awaited (this is what capacity-model.mjs measured)
const D = await awaited(() => evaluateComment(body, { terms }));

const f = (n) => `${n.toFixed(2).padStart(7)} ms`;

console.log(`terms=${terms.length}  body=${body.length}  runs=${RUNS} per cell\n`);
console.log('                     tight loop     await loop');
console.log(`  analyseText      ${f(A)}      ${f(B)}`);
console.log(`  evaluateComment  ${f(C)}      ${f(D)}`);

console.log('\nInterpretation:');
const entryPointEffect = Math.abs(A - D) / Math.max(A, D);
const awaitEffect = Math.abs(A - B) / Math.max(A, B);
console.log(`  await effect on analyseText      : ${(awaitEffect * 100).toFixed(0)}%`);
console.log(`  analyseText(tight) vs eval(await): ${(entryPointEffect * 100).toFixed(0)}%`);
console.log(
  '\n  Cell C is not a fair measurement of evaluateComment (it starts the\n' +
    '  async work without waiting for it, so the cost lands after the timer\n' +
    '  stops). It is printed only to show that, and must not be quoted.'
);
