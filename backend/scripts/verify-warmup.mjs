/**
 * Proves the warm-up actually moves the cost off the request path.
 *
 * This measures the thing my in-suite budget test failed to measure. That
 * test called evaluateComment() once before timing, so it recorded the warm
 * path (~8ms) and passed, while the real first-comment cost was ~10s. A
 * test that warms up cannot detect a warm-up bug.
 *
 * So: two child processes, identical work, one difference.
 *
 *   BASELINE  first comment with a cold pattern cache
 *   WARMED    warmPatternCache() first, then first comment
 *
 * Separate processes because the pattern cache is module-level and lives
 * for the life of the process — measuring both in one process would let
 * the first arm warm the second, which is exactly the mistake being
 * corrected here.
 *
 * PASS = the warmed first comment is dramatically faster, AND both arms
 * return an identical verdict (a fast filter that stopped detecting abuse
 * would be worse than a slow one).
 *
 * Usage: node scripts/verify-warmup.mjs
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, '..');

/**
 * Runs one arm in a fresh process and returns its JSON result.
 *
 * The body is a flagged comment at realistic length: a clean comment would
 * measure only the prefilter, and the prefilter is not what was slow.
 */
const armSource = (warm) => `
import { evaluateComment } from './src/services/moderationService.js';
import { warmPatternCache } from './src/lib/textModeration.js';
import { BUILTIN_WORDLIST } from './src/config/moderationWordlist.js';

const BODY = 'The hostel water has been off for three weeks and the porter is a stupid idiot who does nothing. '.repeat(6).slice(0, 600);

// The terms override bypasses getActiveTerms(), and that is essential.
//
// Without it this script measured database latency, not compile cost. The
// giveaway was the baseline's SECOND comment costing 918ms, which pattern
// caching cannot explain: getActiveTerms() hits Postgres, and on failure it
// returns "wordCache ?? BUILTIN_WORDLIST" WITHOUT populating wordCache — so
// every subsequent call retries the network. Two unrelated costs were being
// summed into one number, and the pattern fix was invisible underneath the
// I/O noise.
//
// Passing terms isolates exactly the thing being fixed while still
// exercising the real service, including the verdict-to-columns mapping.
//
// (That non-caching fallback is a genuine finding in its own right — noted
// in the report as a separate issue, not silently patched here.)
const OPTS = { terms: BUILTIN_WORDLIST };

const run = async () => {
  let warmMs = 0;
  if (${warm}) {
    const stats = await warmPatternCache(BUILTIN_WORDLIST);
    warmMs = stats.ms;
  }

  // The measurement that matters: the FIRST comment this process handles.
  const t0 = process.hrtime.bigint();
  const first = await evaluateComment(BODY, OPTS);
  const firstMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // And a second, to show steady state is unaffected either way.
  const t1 = process.hrtime.bigint();
  await evaluateComment(BODY, OPTS);
  const secondMs = Number(process.hrtime.bigint() - t1) / 1e6;

  // evaluateComment returns { flagged, fields, verdict } — NOT a flat
  // verdict. Reading first.severity/first.matches printed the nonsense
  // "flagged=true severity=null matches=0" on the first run of this
  // script; the equality check still passed because both arms were
  // equally wrong, which is exactly how a bad assertion hides a bug.
  console.log(JSON.stringify({
    warmMs,
    firstMs,
    secondMs,
    flagged: first.flagged,
    status: first.fields.moderationStatus,
    severity: first.verdict.severity ?? null,
    matchCount: first.verdict.matches?.length ?? 0,
  }));

};

run();
`;

const runArm = async (label, warm) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', armSource(warm)],
    { cwd: backendRoot, maxBuffer: 1024 * 1024 }
  );

  const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  return { label, ...JSON.parse(line) };
};

const run = async () => {
  console.log('\nWarm-up verification — separate processes, cold cache each\n');

  const baseline = await runArm('BASELINE (no warm-up)', false);
  const warmed = await runArm('WARMED (warmPatternCache first)', true);

  for (const r of [baseline, warmed]) {
    console.log(
      `  ${r.label.padEnd(34)} warm-up ${r.warmMs.toFixed(0).padStart(5)}ms   ` +
        `1st comment ${r.firstMs.toFixed(1).padStart(8)}ms   2nd ${r.secondMs.toFixed(2).padStart(6)}ms`
    );
    console.log(
      `  ${''.padEnd(34)} verdict: flagged=${r.flagged} severity=${r.severity} matches=${r.matchCount}`
    );
  }

  const speedup = baseline.firstMs / Math.max(warmed.firstMs, 0.001);

  console.log('\nResult:');

  const verdictsMatch =
    baseline.flagged === warmed.flagged &&
    baseline.severity === warmed.severity &&
    baseline.matchCount === warmed.matchCount;

  if (!verdictsMatch) {
    console.log('  ✖ FAIL — the two arms disagree on the verdict. The warm-up changed');
    console.log('    detection behaviour, which is not acceptable regardless of speed.');
    process.exitCode = 1;
    return;
  }
  console.log(`  ✔ Detection identical in both arms (flagged=${warmed.flagged}, severity=${warmed.severity}, ${warmed.matchCount} matches).`);

  if (warmed.firstMs < baseline.firstMs / 3) {
    console.log(`  ✔ First comment: ${baseline.firstMs.toFixed(0)}ms → ${warmed.firstMs.toFixed(1)}ms (${speedup.toFixed(0)}x faster).`);
    console.log(`    The ~${baseline.firstMs.toFixed(0)}ms of compile cost is now paid once at boot`);
    console.log(`    (${warmed.warmMs.toFixed(0)}ms, chunked and yielding) instead of by students.`);
  } else {
    console.log(`  ✖ FAIL — first comment ${baseline.firstMs.toFixed(0)}ms → ${warmed.firstMs.toFixed(0)}ms.`);
    console.log('    The warm-up did not move the cost. Most likely the cache key used by');
    console.log('    warmPatternCache does not match the key analyseText looks up.');
    process.exitCode = 1;
  }
  console.log('');
};

run().catch((err) => {
  console.error('verify-warmup failed:', err.message);
  process.exitCode = 1;
});
