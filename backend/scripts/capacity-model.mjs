/**
 * Measures the moderation path's throughput ceiling on this machine, and
 * converts it into an implied concurrent-student capacity.
 *
 * ## What this is, and what it is NOT
 *
 * This is NOT the load test the task asked for. It does not exercise HTTP,
 * auth, the database, or uploads. It measures ONE thing, honestly: how many
 * comment moderations a single Node process can perform per second, because
 * that work is synchronous and therefore blocks the event loop.
 *
 * It exists because a full 5,000-concurrent-student test is not something
 * this environment can produce a trustworthy number for (see LOAD_TESTING.md).
 * Rather than fabricate percentiles, this measures the one constraint that
 * can be measured locally and reasoned about, and states its assumptions.
 *
 * Run: node scripts/capacity-model.mjs
 */

import { evaluateComment, _maxActiveAdminTerms } from '../src/services/moderationService.js';
import { BUILTIN_WORDLIST, ALLOWLIST } from '../src/config/moderationWordlist.js';
import os from 'node:os';

const cap = _maxActiveAdminTerms();
const terms = [...BUILTIN_WORDLIST];
for (let i = terms.length; i < cap; i += 1) {
  terms.push({ term: `custom phrase ${i.toString(36)}`, category: 'CUSTOM', severity: 'medium' });
}

// Worst realistic case: a long clean comment containing every letter, so
// the prefilter rejects nothing and every pattern runs to completion.
// See PERF_MODERATION.md for why the pangram is the row that matters.
const body =
  'The quick brown fox jumps over the lazy dog while every student waits for the bursary payment to be approved by the finance office and nobody explains the delay. '.repeat(
    12
  ).slice(0, 2000);

/**
 * Warm-up depth matters more than anything else in this script.
 *
 * A single warm-up call is NOT enough. scripts/resolve-discrepancy.mjs
 * showed my three earlier benchmarks disagreeing by up to 7x (11.56 / 4.33 /
 * 2.34 ms) for identical work, and the cause was not the entry point and not
 * the `await` — those made 1% difference. It was warm-up: V8 tiers a regex
 * up from the interpreter only after it has executed enough times, and with
 * 400 patterns that takes a few hundred moderations, not one.
 *
 * With 30+ warm iterations all four measurement variants converge on
 * ~1.56 ms. That is the steady-state figure; anything higher is measuring
 * tier-up, which a long-lived server pays once rather than per comment.
 */
for (let i = 0; i < 60; i += 1) {
  // eslint-disable-next-line no-await-in-loop
  await evaluateComment(body, { terms, allowlist: ALLOWLIST });
}


// Measure sustained throughput over a fixed wall-clock window rather than a
// fixed iteration count, so a slow machine reports fewer ops rather than
// taking longer and reporting the same figure.
const WINDOW_MS = 3000;
let ops = 0;
const t0 = process.hrtime.bigint();
while (Number(process.hrtime.bigint() - t0) / 1e6 < WINDOW_MS) {
  // eslint-disable-next-line no-await-in-loop
  await evaluateComment(body, { terms, allowlist: ALLOWLIST });
  ops += 1;
}
const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

const perOpMs = elapsedMs / ops;
const opsPerSec = 1000 / perOpMs;

console.log('=== Moderation throughput (measured) ===');
console.log(`  host              : ${os.cpus().length} logical CPUs, ${(os.totalmem() / 1e9).toFixed(1)} GB RAM`);
console.log(`  node              : ${process.version}`);
console.log(`  terms             : ${terms.length}`);
console.log(`  body              : ${body.length} chars (pangram, worst case)`);
console.log(`  moderations       : ${ops} in ${elapsedMs.toFixed(0)} ms`);
console.log(`  per moderation    : ${perOpMs.toFixed(2)} ms of blocking CPU`);
console.log(`  ceiling, 1 process: ${opsPerSec.toFixed(0)} comment submissions/sec\n`);

/**
 * Converts that ceiling into concurrent students under an explicit
 * behavioural assumption. The assumption is the weakest link here and is
 * stated as a variable, not buried.
 *
 * A student browsing the portal does not submit a comment every second.
 * Reads (dashboard, ticket list, notifications) do not touch this path at
 * all. The figure below therefore answers: "how many simultaneously active
 * students can be supported before comment moderation alone saturates one
 * process?"
 */
console.log('=== Implied capacity (modelled, NOT measured end-to-end) ===');
for (const secondsBetweenComments of [30, 60, 120, 300]) {
  const students = opsPerSec * secondsBetweenComments;
  console.log(
    `  1 comment per student per ${String(secondsBetweenComments).padStart(3)}s -> ` +
      `${Math.round(students).toLocaleString().padStart(9)} concurrent students`
  );
}

console.log(
  '\nCaveats that make the numbers above an UPPER BOUND, not a capacity:\n' +
    '  - moderation CPU only; excludes auth, DB, serialisation, TLS, uploads\n' +
    '  - single process; no other request competing for the event loop\n' +
    '  - measured on a developer laptop, not the production host\n' +
    '  - a production host that sleeps/cold-starts pays warm-up again\n' +
    '  - real capacity is set by whichever resource saturates FIRST, which\n' +
    '    is very likely the database or the host, not this path'
);
