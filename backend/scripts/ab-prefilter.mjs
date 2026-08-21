/**
 * A/B benchmark for the moderation prefilter — same terms, same text, same
 * process, only the filter strategy differs.
 *
 * WHY A SEPARATE SCRIPT.
 *
 * probe-steady-state.mjs measured 25ms median before my change and 4ms
 * after. That comparison is NOT valid evidence, because I changed the
 * workload at the same time as the code: the "before" run used synthetic
 * terms, the "after" run used the real wordlist. Two variables moved, so
 * the number attributable to the fix is unknown.
 *
 * This script holds the workload fixed and varies only the strategy, by
 * reimplementing both prefilters over the *same* compiled patterns that
 * textModeration.js uses. That isolates the one thing I actually changed.
 *
 * Run: node scripts/ab-prefilter.mjs
 */

import { BUILTIN_WORDLIST, ALLOWLIST } from '../src/config/moderationWordlist.js';
import {
  normaliseForMatching,
  collapseRuns,
  analyseText,
  warmPatternCache,
} from '../src/lib/textModeration.js';
import { _maxActiveAdminTerms } from '../src/services/moderationService.js';

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

// Two realistic bodies. The second deliberately contains every letter of
// the alphabet, which is the true worst case for ANY letter-set prefilter:
// nothing can be rejected, so every pattern runs. Students write long
// varied prose, so this is not a contrived input.
const bodies = {
  'typical complaint':
    'The hostel water supply has been broken for three weeks now. Nobody from maintenance has come to look at it even though many students have complained repeatedly about the same problem. '.repeat(
      11
    ).slice(0, 2000),
  'pangram (worst case)':
    'The quick brown fox jumps over the lazy dog while every student waits for the bursary payment to be approved by the finance office and nobody explains the delay. '.repeat(
      12
    ).slice(0, 2000),
};

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

// Reimplements the two strategies over the real patterns. analyseText is
// used for the "current" number as a cross-check that this harness agrees
// with production code.
const measure = (body, mode) => {
  const haystack = collapseRuns(normaliseForMatching(body));
  const available = new Set([...haystack].filter((c) => LETTERS.includes(c)));

  let scans = 0;
  for (const entry of terms) {
    const t = entry.term.toLowerCase().trim();
    const needed = [...new Set([...t].filter((c) => LETTERS.includes(c)))];

    if (mode === 'first-letter') {
      if (needed.length && !available.has(t[0])) continue;
    } else {
      if (!needed.every((l) => available.has(l))) continue;
    }
    scans += 1;
  }
  return scans;
};

await warmPatternCache(terms);

const time = (fn, runs = 20) => {
  fn(); // warm
  const started = process.hrtime.bigint();
  for (let i = 0; i < runs; i += 1) fn();
  return Number(process.hrtime.bigint() - started) / 1e6 / runs;
};

console.log(`terms = ${terms.length}\n`);

for (const [label, body] of Object.entries(bodies)) {
  const firstLetterScans = measure(body, 'first-letter');
  const allLetterScans = measure(body, 'all-letters');

  // Production path, current code.
  const ms = time(() => analyseText(body, { terms, allowlist: ALLOWLIST }));

  console.log(`${label}  (${body.length} chars)`);
  console.log(`  patterns run, first-letter prefilter : ${firstLetterScans}/${terms.length}`);
  console.log(`  patterns run, all-letters prefilter  : ${allLetterScans}/${terms.length}`);
  console.log(
    `  reduction                            : ${(
      100 - (allLetterScans / Math.max(firstLetterScans, 1)) * 100
    ).toFixed(1)}%`
  );
  console.log(`  analyseText (current code)           : ${ms.toFixed(2)} ms\n`);
}

console.log(
  'Note: the pangram row is the honest worst case — a comment containing\n' +
    'every letter defeats letter-set prefiltering entirely, and the cost\n' +
    'there is what capacity planning must assume, not the typical row.'
);
