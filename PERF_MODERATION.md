# Moderation scan cost — measurements and one retracted claim

Evidence for the comment-moderation CPU cost, including a claim I made and
then disproved. Reproduce with the scripts named in each section.

## Retracted claim: "prefilter fix took 25ms → 4ms"

**This was wrong, and I am recording it rather than deleting it.**

`scripts/probe-steady-state.mjs` reported a 25.3ms median before I changed
the prefilter and 4.33ms after, and I initially read that as a 6x win from
the change. It is not valid evidence, because I changed two things at once:

- the code (first-letter prefilter → all-letters prefilter), **and**
- the workload (400 synthetic `probeterm…` strings → the real wordlist)

Two variables moved, so nothing about the delta is attributable to the fix.

The synthetic workload was also actively misleading. Every `probeterm…`
contains the letter `m`; the probe body contains no `m` at all. Under an
all-letters prefilter every one of those 400 terms is rejected without
running a regex, so the "after" number was measuring almost no work.

## What the fix is actually worth

`scripts/ab-prefilter.mjs` holds the workload fixed and varies only the
prefilter strategy, over the same compiled patterns, in one process:

| body | patterns run, first-letter | patterns run, all-letters | reduction |
|---|---|---|---|
| typical complaint (2000 chars) | 398/400 | 362/400 | **9.0%** |
| pangram (1944 chars) | 400/400 | 400/400 | **0.0%** |

So the prefilter change is a ~9% reduction on typical prose and **nothing at
all** in the worst case. It is a minor improvement, not the fix to a
bottleneck, and the earlier 6x figure must not be quoted anywhere.

The reason is simple in hindsight: ordinary English prose of 2000 characters
contains nearly every letter of the alphabet, so a letter-set prefilter has
almost nothing to reject. Any comment containing all 26 letters defeats the
technique completely. **Capacity planning must use the pangram row.**

## Correctness cost of the change — a real bypass I introduced

Tightening the prefilter introduced a genuine detection regression, caught
by the existing `resists filter bypass` test in `textModeration.test.mjs`:

`possibleLetters()` added only the character itself for plain `a`–`z` input
and `continue`d past the `CHAR_TO_LETTERS` lookup. But plain letters *are*
substitutes for other letters — `k` is in class `c`, `z` is in class `s`,
`v` is in class `u`. So `"kunt"` never registered a possible `c`, the term
`cunt` was skipped without running its pattern, and the comment passed.

A prefilter is only sound if its letter set is a **superset** of what the
text could spell. Fixed by not short-circuiting; test suite green after.

This is the risk in the whole technique: a prefilter bug fails *open* and
silently, and only a detection test catches it. Two prefilter bugs in one
change, for a 9% gain, is a poor trade — see the recommendation below.

## Unresolved discrepancy between the two harnesses

For nominally identical work (400 terms, 2000-char body) the two scripts
disagree:

- `probe-steady-state.mjs` (via `evaluateComment`): median **4.33 ms**
- `ab-prefilter.mjs` (via `analyseText`): **11.56 ms**

~2.7x apart. Candidate causes, none confirmed: the async `evaluateComment`
path yields between calls and lets GC run, whereas the tight synchronous
loop accumulates pressure; or the service layer filters/dedups terms before
reaching `analyseText`. **I have not identified which, so neither figure
should be treated as the per-comment cost.** The order of magnitude —
single-digit-to-low-tens of milliseconds of synchronous CPU per comment —
is the part both agree on and the only part I would rely on.

## Standing recommendation

Letter-set prefiltering is the wrong tool here. The scan is ~400
independent bounded regexes over the same string; the right structure is a
single Aho–Corasick automaton over the substitution classes, giving one
pass over the text regardless of list size, with no fail-open prefilter to
get subtly wrong. That is a larger change than this task should absorb, but
it is the fix if comment throughput ever becomes the binding constraint.

Until then the honest statement is: per-comment moderation costs single-digit
to low-tens of milliseconds of **synchronous, event-loop-blocking** CPU, and
that cost is what limits comment submissions per second on a single Node
process — not the database.
