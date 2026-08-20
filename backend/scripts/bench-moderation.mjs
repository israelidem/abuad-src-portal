/**
 * Measures analyseText() cost as the admin word list grows.
 *
 * Why this exists: the moderation filter runs synchronously inside the
 * comment-submission request, on Node's single thread. If it costs 50ms per
 * comment, that 50ms is added to every submission *and* blocks every other
 * request in flight — so this is the one number that decides whether an
 * admin-managed blocklist is safe to let grow.
 *
 * IMPORTANT: this is a microbenchmark of one function, not a load test. It
 * says nothing about concurrent users, database behaviour, or end-to-end
 * latency. It answers exactly one question: does adding admin words make
 * comment submission slow?
 *
 *   node scripts/bench-moderation.mjs
 */

import { analyseText } from '../src/lib/textModeration.js';

/**
 * Realistic comment bodies. Benchmarking only abusive text would be
 * misleading — the common case by far is a clean comment, and a clean
 * comment is the *worst* case for the matcher because nothing short-circuits:
 * every pattern must run to completion before it can conclude "no match".
 */
const CLEAN_SHORT = 'Thanks for looking into this, the issue is resolved now.';

const CLEAN_LONG = `I submitted a complaint about the hostel water supply three
weeks ago and have not had a response. The maintenance staff came once, looked
at the tank on the second floor, and said they would return with a part. Nobody
has been back since. I have attached photographs of the bathroom on the third
floor. Several students on my corridor are now washing in the block next door,
which is causing friction with the students there. Please could someone confirm
who is responsible for this so I can follow up directly. My matriculation
number is CSC/19/1234 and I am happy to be contacted by email.`.repeat(2);

const ABUSIVE = 'you are a f u c k i n g idiot and I will find you';

/**
 * Synthetic admin terms, spread across the alphabet.
 *
 * Deliberately *not* real profanity: real words would collide with the
 * built-in list and get deduplicated, understating the cost.
 *
 * The first letter is varied on purpose. `analyseText` prefilters by the set
 * of canonical letters the text could contain, so a term whose initial is
 * absent never runs its regex. A list that all starts with one letter
 * defeats that prefilter entirely and is *not* what a real blocklist looks
 * like — measuring only that would overstate the cost by an order of
 * magnitude. (My first version of this script made exactly that mistake; see
 * the pathological row below for what it was actually measuring.)
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

const syntheticTerms = (count) =>
  Array.from({ length: count }, (_, i) => ({
    term: `${ALPHABET[i % 26]}qx${i.toString(36)}term`,
    severity: 'medium',
    category: 'PROFANITY',
  }));

/**
 * Worst case: every term shares one initial, so the prefilter admits all of
 * them on any text containing that letter — or anything that *normalises* to
 * it. `2` folds to `z` under leetspeak substitution, so a matriculation
 * number like CSC/19/1234 is enough to trigger the full scan.
 *
 * Not realistic as an admin list, but it is the shape an attacker with admin
 * access would choose, and it bounds the damage a careless bulk import can do.
 */
const pathologicalTerms = (count) =>
  Array.from({ length: count }, (_, i) => ({
    term: `zqx${i.toString(36)}term`,
    severity: 'medium',
    category: 'PROFANITY',
  }));

/** Wall-clock ms for `iterations` calls, plus the per-call mean. */
const timeIt = (label, fn, iterations) => {
  // Warm up so we measure steady state rather than JIT compilation and
  // first-call pattern building.
  for (let i = 0; i < 50; i += 1) fn();

  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }

  samples.sort((a, b) => a - b);
  return {
    label,
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
    p50: samples[Math.floor(samples.length * 0.5)],
    p95: samples[Math.floor(samples.length * 0.95)],
    p99: samples[Math.floor(samples.length * 0.99)],
    max: samples[samples.length - 1],
  };
};

const fmt = (n) => n.toFixed(3).padStart(8);

const ITERATIONS = 300;

console.log('\nanalyseText() cost vs admin word-list size');
console.log(`${ITERATIONS} iterations per row, after 50 warm-up calls.`);
console.log('All figures in milliseconds.\n');

const rows = [];

for (const wordCount of [0, 50, 200, 500, 1000]) {
  const terms = syntheticTerms(wordCount);

  for (const [name, body] of [
    ['clean short', CLEAN_SHORT],
    ['clean long ', CLEAN_LONG],
    ['abusive    ', ABUSIVE],
  ]) {
    rows.push({
      words: wordCount,
      ...timeIt(`${wordCount} words / ${name}`, () => analyseText(body, { terms }), ITERATIONS),
    });
  }
}

// The prefilter-defeating shape, at the same size, for comparison.
const pathological = timeIt(
  '1000 same-initial / clean long ',
  () => analyseText(CLEAN_LONG, { terms: pathologicalTerms(1000) }),
  ITERATIONS
);
rows.push({ words: 1000, ...pathological });

console.log('  words  body           mean      p50      p95      p99      max');
console.log('  ' + '-'.repeat(68));
for (const r of rows) {
  const [words, body] = r.label.split(' / ');
  console.log(
    `  ${words.replace(' words', '').padStart(5)}  ${body}  ${fmt(r.mean)} ${fmt(r.p50)} ${fmt(r.p95)} ${fmt(r.p99)} ${fmt(r.max)}`
  );
}

/**
 * Verdict against a budget rather than an eyeballed number.
 *
 * 10ms is the threshold I care about: comment submission already does a
 * database write and a notification fan-out, so single-digit milliseconds of
 * CPU is noise, while tens of milliseconds of *blocking* CPU per request
 * starts to matter at concurrency because it stalls the event loop.
 */
const BUDGET_MS = 10;

// Judged on the realistic rows. The pathological row is reported separately
// rather than folded in — holding the design to a shape no real blocklist
// has would be measuring the benchmark, not the code.
const realistic = rows.filter((r) => !r.label.includes('same-initial'));
const worst = realistic.reduce((a, b) => (b.p99 > a.p99 ? b : a));

console.log(`\n  Worst realistic p99: ${worst.p99.toFixed(3)}ms — ${worst.label}`);
console.log(
  `  Pathological (1000 terms sharing one initial): p99 ${pathological.p99.toFixed(3)}ms, ` +
    `${(pathological.mean / realistic.find((r) => r.label.startsWith('1000 words / clean long')).mean).toFixed(1)}x the realistic list of the same size.`
);

const scaling = (() => {
  const baseline = rows.find((r) => r.label.startsWith('0 words / clean long'));
  const largest = rows.find((r) => r.label.startsWith('1000 words / clean long'));
  return largest.mean / baseline.mean;
})();

console.log(`  1000 admin words cost ${scaling.toFixed(1)}x the empty list (clean long body).`);

if (worst.p99 > BUDGET_MS) {
  console.log(`\n  ✖ OVER BUDGET (${BUDGET_MS}ms p99). The event loop would stall`);
  console.log('    under concurrent submissions. Precompile one alternation');
  console.log('    per severity instead of one pattern per term.\n');
  process.exit(1);
}

console.log(`\n  ✔ Within the ${BUDGET_MS}ms p99 budget at every size tested.\n`);
