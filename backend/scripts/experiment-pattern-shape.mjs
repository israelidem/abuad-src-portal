/**
 * Which part of the generated pattern costs 25ms per term?
 *
 * probe-moderation-cost.mjs found that the FIRST use of a term set costs
 * ~9,962ms for 400 terms (~25ms each) while subsequent scans cost 8ms
 * total. Something about each pattern is expensive exactly once.
 *
 * Two candidate causes, with different fixes:
 *
 *   A. Parsing/codegen of a large pattern. A 12-character term expands to
 *      ~800 characters of nested, bounded quantifiers, so the RegExp
 *      constructor has real work to do.
 *
 *   B. V8 runs a new regex in its interpreter and only tier-ups to
 *      compiled code after repeated execution. The first exec against a
 *      2000-char string would then be far slower than later ones.
 *
 * Either way the fix direction is the same — make the pattern cheaper —
 * but I need to know *which knob* matters before touching a matcher that
 * 199 tests depend on. So this measures the current shape against
 * progressively simpler ones, timing construction and first-exec
 * separately.
 *
 * Nothing here imports production code. It reproduces the shape locally so
 * the experiment cannot accidentally mutate the real pattern cache.
 *
 * Usage: node scripts/experiment-pattern-shape.mjs
 */

const SEPARATOR = String.raw`[^\p{L}\p{N}]`;

const LETTER_CLASSES = {
  a: 'a@4^*#', b: 'b86', c: 'c(<{[', d: 'd', e: 'e3€*#', f: 'f', g: 'g96',
  h: 'h', i: 'i1!|l¡*#', j: 'j', k: 'k', l: 'l1|!', m: 'm', n: 'nñ',
  o: 'o0()*#', p: 'p', q: 'q', r: 'r', s: 's5$z', t: 't7+', u: 'uv*#',
  v: 'vu', w: 'w', x: 'x', y: 'y', z: 'z2s',
};

const escapeInClass = (s) => s.replace(/[\\\]^-]/g, '\\$&');
const escapeLiteral = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Builds a pattern for `term` with the tolerance knobs exposed, so each
 * can be varied independently.
 *
 * @param classMax  upper bound on `[class]{1,N}` — how many characters one
 *                  letter may span. Run-collapsing already caps repeats at
 *                  two, so 3 may be one more than is needed.
 * @param repeatMax upper bound on the separated-repeat group `{0,N}` —
 *                  this is what catches "F.U.U.C.K".
 * @param gapMax    upper bound on the between-letter separator run.
 */
const buildPattern = (term, { classMax, repeatMax, gapMax }) => {
  const chars = [...term];
  const parts = [];

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];

    if (ch === ' ' || ch === '-' || ch === '_') {
      parts.push(`${SEPARATOR}{0,4}`);
      continue;
    }

    const klass = LETTER_CLASSES[ch];
    if (klass) {
      const cls = `[${escapeInClass(klass)}]{1,${classMax}}`;
      parts.push(repeatMax > 0 ? `${cls}(?:${SEPARATOR}{1,3}${cls}){0,${repeatMax}}` : cls);
    } else {
      parts.push(escapeLiteral(ch));
    }

    const next = chars[i + 1];
    const nextIsGap = next === ' ' || next === '-' || next === '_';
    if (next !== undefined && !nextIsGap && gapMax > 0) parts.push(`${SEPARATOR}{0,${gapMax}}`);
  }

  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join('')}(?![\\p{L}\\p{N}])`, 'gu');
};

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const TERM_COUNT = 400;

/** Fresh term strings per variant, so no pattern can be reused between runs. */
const makeTerms = (salt) =>
  Array.from({ length: TERM_COUNT }, (_, i) => `${ALPHABET[i % 26]}q${salt}${i.toString(36)}term`);

// The realistic worst case: schema-maximum length, clean, so every pattern
// runs to completion instead of short-circuiting on a hit.
const BODY = 'The hostel water supply has been broken for three weeks now. '.repeat(34).slice(0, 2000);

const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;

const measure = (label, knobs, salt) => {
  const terms = makeTerms(salt);

  // 1. Construction only.
  let t = process.hrtime.bigint();
  const patterns = terms.map((term) => buildPattern(term, knobs));
  const buildMs = ms(t);

  // 2. First exec of each pattern.
  t = process.hrtime.bigint();
  for (const p of patterns) {
    p.lastIndex = 0;
    p.exec(BODY);
  }
  const firstExecMs = ms(t);

  // 3. Steady state: the same patterns, executed again.
  t = process.hrtime.bigint();
  for (let round = 0; round < 5; round += 1) {
    for (const p of patterns) {
      p.lastIndex = 0;
      p.exec(BODY);
    }
  }
  const steadyMs = ms(t) / 5;

  const size = patterns[0].source.length;
  console.log(
    `  ${label.padEnd(34)} build ${buildMs.toFixed(0).padStart(6)}ms   ` +
      `first-exec ${firstExecMs.toFixed(0).padStart(7)}ms   ` +
      `steady ${steadyMs.toFixed(1).padStart(7)}ms   pattern ${size} chars`
  );

  return { label, buildMs, firstExecMs, steadyMs, size };
};

console.log(`\nPattern-shape cost — ${TERM_COUNT} terms, ${BODY.length}-char clean body`);
console.log('  build      = constructing the RegExp objects');
console.log('  first-exec = first exec() of each (includes any lazy compile / interpreter tier)');
console.log('  steady     = mean of 5 further passes over the same patterns\n');

const results = [
  measure('current: {1,3} rep{0,2} gap{0,3}', { classMax: 3, repeatMax: 2, gapMax: 3 }, 'a'),
  measure('class {1,2}', { classMax: 2, repeatMax: 2, gapMax: 3 }, 'b'),
  measure('repeat {0,1}', { classMax: 3, repeatMax: 1, gapMax: 3 }, 'c'),
  measure('class {1,2} + repeat {0,1}', { classMax: 2, repeatMax: 1, gapMax: 3 }, 'd'),
  measure('no separated repeat', { classMax: 2, repeatMax: 0, gapMax: 3 }, 'e'),
  measure('no repeat, no gap (strict)', { classMax: 2, repeatMax: 0, gapMax: 0 }, 'f'),
];

const base = results[0];
const baseTotal = base.buildMs + base.firstExecMs;

console.log('\nCold cost (build + first-exec) relative to current shape:\n');
for (const r of results) {
  const total = r.buildMs + r.firstExecMs;
  const factor = baseTotal / Math.max(total, 0.001);
  const bar = '#'.repeat(Math.max(1, Math.round((total / baseTotal) * 40)));
  console.log(`  ${r.label.padEnd(34)} ${total.toFixed(0).padStart(6)}ms  ${factor.toFixed(1)}x faster  ${bar}`);
}

console.log('\nWhere the cold cost actually sits:');
const buildShare = (base.buildMs / baseTotal) * 100;
if (buildShare > 60) {
  console.log(`  Construction: ${buildShare.toFixed(0)}% of cold cost. Parsing/codegen of a`);
  console.log(`  ${base.size}-char pattern dominates. Fewer/simpler patterns is the fix.`);
} else {
  console.log(`  First exec: ${(100 - buildShare).toFixed(0)}% of cold cost (build is only ${buildShare.toFixed(0)}%).`);
  console.log('  So construction is cheap and the first run against real text is what costs —');
  console.log("  consistent with V8 interpreting a new regex before tiering it up. Steady state");
  console.log(`  is ${base.steadyMs.toFixed(1)}ms, i.e. ${(base.firstExecMs / Math.max(base.steadyMs, 0.001)).toFixed(0)}x cheaper than the first pass.`);
}
console.log('');
