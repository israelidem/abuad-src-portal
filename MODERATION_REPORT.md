# Feedback Portal Task — Status Report

**Date:** 2026-08-20
**Scope requested:** 16 work areas (moderation, rate limiting, Cloudinary, load
testing to 5,000 concurrent users, feedback tab, ratings, and more).
**Scope delivered:** Area 1 (automatic comment abuse flagging) — the matcher
core, complete and verified. Everything else is **not started**.

This report is deliberately blunt about that split, because the task's own
closing instruction was:

> Do not simply tell me that something was implemented. Verify it through the
> code, tests, and appropriate simulations, and report evidence of the result.

Claiming 16 areas were done when one was would be exactly the failure that
instruction is guarding against.

---

## Implemented and verified

### Obfuscation-tolerant comment moderation matcher

**Files added**

| File | Purpose |
| --- | --- |
| `backend/src/config/moderationWordlist.js` | Seed word list (~150 terms) + allowlist (~70 words) |
| `backend/src/lib/textModeration.js` | Pure matcher: normalise → mask allowlist → match |
| `backend/tests/textModeration.test.mjs` | 63 tests |

**Evidence**

New tests, in isolation:

```
$ node --test --test-reporter=dot backend/tests/textModeration.test.mjs
....................
....................
....................
...
exit code 0     # 63/63 pass
```

Full backend suite, confirming no regression in existing tests:

```
$ cd backend && npm test
ℹ tests 144
ℹ pass 144
ℹ fail 0
```

144 = 81 pre-existing + 63 new. No existing test was modified, skipped or
weakened to get there.


**How it works** — three stages, in order:

1. **Normalise.** NFKD Unicode fold (catches fullwidth `ｆｕｃｋ`), strip
   combining marks (`fúçk` → `fuck`), remove zero-width/bidi characters,
   lowercase, collapse 3+ character runs to 2 (`fuuuuuck` → `fuuck`).
2. **Mask the allowlist.** Legitimate words are blanked to `x` of equal
   length *before* any prohibited term is searched, so `assessment` can never
   contribute to a match. `x` is in no term and no substitution class, so the
   mask cannot form a new match at the seam.
3. **Match.** Each term compiles to a bounded regex: letters become
   `[class]{1,3}` with substitutions (`a@4^*#`, `i1!|l`, `s5$z`), separators
   allowed between letters, and word-boundary lookarounds.

**Bypass techniques covered** (each has a test):

capitalisation · punctuation between letters (`f.u.c.k`) · spaces between
letters (`f u c k`) · repeated characters (`fuuuuuuck`) · substitution
(`fvck`, `b1tch`, `n1gger`) · symbol masking (`f*ck`, `a$$hole`) · leetspeak
(`f4gg0t`) · zero-width injection · phrases with spaces removed
(`killyourself`) · combined techniques (`F.U.U.C.K`, `N I G G E R`)

**False positives guarded** — 20 assertions on real complaint text:
`assessment`, `assignment`, `class`, `classification`, `password`,
`cockroach`, `therapist`, `analysis`, `documents`, `circumstances`, `grass`,
`cucumber`, `shuttlecock`, `matriculation`, `skills`, `massive`,
`association`, `sexuality`, `glass`, `assist`. All pass unflagged.

This group matters most. A filter that flags "assessment" trains moderators
to click Approve without reading, which is worse than no filter.

**Severity model**

| Severity | Behaviour |
| --- | --- |
| `high` | Flag **and** hide from the public thread pending review |
| `medium` | Flag, comment stays visible |
| `low` | Flag only when 2+ hits land in one comment |

Two deliberate exceptions:

- **Single low-severity hits are not flagged.** One "damn" in a complaint
  about a broken toilet is not a moderation case, and flagging it buries the
  queue in noise until staff stop reading it.
- **Self-harm is flagged but never hidden.** Hiding a student's cry for help
  takes it off the thread where someone might answer it — the opposite of
  what the flag is for. Tested explicitly.

**Two real bugs the tests caught and fixed**

1. `sh1t sh1t` went unflagged. The matcher de-duplicated by term, so repeated
   use of one low-severity word counted as a single hit and fell under the
   threshold — precisely the pattern the threshold exists to catch. Fixed by
   counting occurrences (capped at 25) rather than distinct terms.
2. `F.U.U.C.K` went unflagged. Run-collapsing only sees *adjacent*
   duplicates; here the doubled `u` has a full stop between the copies. Fixed
   by adding `(?:SEP{1,3}[class]{1,3}){0,2}` per letter unit.

Both were found by tests written before the code was trusted, not by
inspection.

**ReDoS safety.** Several characters are legal both as separator and as
letter substitute (`*`, `#`, `!`, `|`). With unbounded quantifiers that
overlap is a catastrophic-backtracking shape — a comment of 2,000 asterisks
could hang the request thread. Every quantifier is bounded. Asserted by test:
2,000 `*` characters scan in under 1 s (actual: ~2 ms).

**Performance.** A ~1.8 KB clean comment scans in ~34 ms against the full
list. Two optimisations: compiled patterns are cached per process (bounded at
2,000), and a first-letter prefilter skips most terms without running their
regex.

---

## Not implemented

None of the following was started. No code, no tests, no measurements.

| # | Area |
| --- | --- |
| 1b | Admin-managed word CRUD (DB table, API, dashboard UI) |
| 2 | Flagged-comments moderation interface + backend authorization |
| 3 | Per-endpoint rate limiting |
| 4 | Cloudinary storage migration |
| 5 | Load testing at 100 / 500 / 2,500 / 5,000 concurrent students |
| 6 | Super Admin manual user registration |
| 7 | Mobile notification bell fix |
| 8 | Contact Developer footer modal |
| 9 | Feedback tab + admin review workflow |
| 10 | In-app rating prompt + admin ratings review |
| 11 | Security review |
| 12 | Database/API performance review |
| 13 | Responsive/accessibility review |

The existing suite *was* run (144/144 pass, above), so unit-level regression
is confirmed. Functional regression testing of major workflows through the
running application was not performed.


### On the load-testing requirement specifically

**No load test was run. There is no evidence this portal supports 100
concurrent students, let alone 5,000.** The task explicitly warned against
claiming otherwise, so: unknown, unmeasured.

Worth flagging from the architecture read, as hypotheses to test rather than
conclusions — the backend runs on Render with Supabase's transaction pooler
at `connection_limit=1` per instance, which is the first thing likely to
bind under concurrency, and notification polling on an interval multiplies
request volume by the number of open tabs. Both need measuring before either
is called a bottleneck.

---

## Integration still required

The matcher is a pure function and is **not yet wired to anything**. No
comment currently gets flagged in the running application. To connect it:

1. Migration adding `moderation_words` (admin terms, `enabled` flag) and
   moderation columns/table for flag state, reason, and audit trail.
2. A `moderationService` that merges built-in + enabled admin terms, cached
   with short TTL so admin edits apply without a restart.
3. Call `analyseText` in the comment-creation path; persist status, reason,
   and matched evidence.
4. Filter hidden comments out of student-facing reads — server-side, in the
   query.
5. Moderation queue endpoints and UI, with authorization enforced on the API
   and not only in the router guard.

Step 4 is the one that carries real risk: if hiding is done in the frontend,
the comment is still in the API response and the moderation is decorative.

---

## Recommendation

Areas 2 and 3 (moderation interface, rate limiting) are the highest value
next steps: area 2 makes the matcher useful, and area 3 closes an abuse gap
that exists today regardless of moderation. Area 5 should come before any
capacity claim is made anywhere in the project's documentation.
