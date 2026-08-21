/**
 * Measures the real per-comment cost of the moderation scan.
 *
 * Why this exists: the STEADY STATE budget test failed on one run and
 * passed on the previous one. The distribution below showed why — the
 * assertion sat almost exactly on the median, so it was a coin flip. The
 * underlying cause was a real bottleneck, not test flakiness:
 *
 *   before (first-letter prefilter): min 11.9 / median 25.3 / max 58.1 ms
 *
 * MEASUREMENT TRAP, hit while writing this script — worth keeping.
 *
 * My first version generated synthetic terms ('probeterm0', 'probeterm1',
 * …) and timed those. Every one of them contains the letter `m`, and the
 * probe body ("The hostel water supply has been broken…") contains no `m`
 * at all. Against the improved all-letters prefilter, all 400 terms are
 * rejected without running a single regex, so the script would have
 * reported a spectacular speedup that no real deployment would ever see.
 *
 * So this version measures the REAL built-in wordlist, and prints how many
 * terms actually survive the prefilter. If that survivor count is ~0 the
 * timing below is meaningless and the number must not be quoted.
 *
 * Run: node scripts/probe-steady-state.mjs
 */

import { evaluateComment, _maxActiveAdminTerms } from '../src/services/moderationService.js';
import { BUILTIN_WORDLIST, ALLOWLIST } from '../src/config/moderationWordlist.js';

import { normaliseForMatching, collapseRuns } from '../src/lib/textModeration.js';

// Realistic worst case: a clean comment. Nothing short-circuits, so every
// surviving pattern runs to completion before concluding "no match".
const body =
  'The hostel water supply has been broken for three weeks now. Nobody from maintenance has come to look at it even though many students have complained repeatedly about the same problem. '.repeat(
    11
  ).slice(0, 2000);

// Pad the built-in list out to the admin cap with plausible admin entries,
// so this reflects a fully-loaded deployment rather than a fresh one.
const cap = _maxActiveAdminTerms();
const adminish = [
  'useless staff', 'corrupt admin', 'thieving bursar', 'nonsense portal',
  'rubbish service', 'incompetent warden', 'shameless lecturer', 'wicked people',
];
const terms = [...BUILTIN_WORDLIST];

for (let i = terms.length; i < cap; i += 1) {
  terms.push({
    term: `${adminish[i % adminish.length]} ${i.toString(36)}`,
    category: 'CUSTOM',
    severity: 'medium',
  });
}

/**
 * Reproduces the prefilter to report how many terms genuinely reach the
 * regex stage. Without this the timing above cannot be interpreted.
 */
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const haystackLetters = new Set(
  [...collapseRuns(normaliseForMatching(body))].filter((c) => LETTERS.includes(c))
);
let survivors = 0;
for (const entry of terms) {
  const t = (typeof entry === 'string' ? entry : entry.term).toLowerCase().trim();
  const needed = new Set([...t].filter((c) => LETTERS.includes(c)));
  // Approximate: ignores substitution classes, so this is a lower bound on
  // survivors. Good enough to answer "is the timing meaningful".
  if ([...needed].every((l) => haystackLetters.has(l))) survivors += 1;
}

// Warm up, so we time steady state rather than pattern compilation.
await evaluateComment(body, { terms, allowlist: ALLOWLIST });

const TRIALS = 12;
const RUNS = 20;
const means = [];

for (let t = 0; t < TRIALS; t += 1) {
  const started = process.hrtime.bigint();
  for (let i = 0; i < RUNS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await evaluateComment(body, { terms, allowlist: ALLOWLIST });
  }
  means.push(Number(process.hrtime.bigint() - started) / 1e6 / RUNS);
}

means.sort((a, b) => a - b);
const fmt = (n) => n.toFixed(2).padStart(7);

console.log(`terms=${terms.length}  body=${body.length} chars  ${TRIALS} trials x ${RUNS} runs`);
console.log(
  `terms reaching the regex stage (lower bound): ${survivors}/${terms.length}` +
    (survivors === 0 ? '  <-- TIMING BELOW IS MEANINGLESS' : '')
);
console.log('');
console.log(`  min    ${fmt(means[0])} ms`);
console.log(`  median ${fmt(means[Math.floor(means.length / 2)])} ms`);
console.log(`  max    ${fmt(means[means.length - 1])} ms`);
console.log(`\n  all: ${means.map((m) => m.toFixed(1)).join(', ')}`);

const over25 = means.filter((m) => m >= 25).length;
console.log(`\n  trial means at or above the old 25ms assertion: ${over25}/${TRIALS}`);
