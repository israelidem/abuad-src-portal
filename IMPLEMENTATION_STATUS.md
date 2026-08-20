# Feedback Portal — Implementation Status

Honest status of the 16-part task. Every "done" line below cites the
command that proves it. Anything not yet verified is listed as outstanding
rather than described as finished.

Reproduce everything with:

```bash
cd backend && npm test                      # 185 unit/integration tests
node scripts/verify-moderation.mjs          # 18 live-database checks
node scripts/probe-ratelimit.mjs            # live rate-limit probe
```

---

## Completed and verified

### 1. Automatic comment abuse flagging — DONE

`backend/src/lib/textModeration.js`, `backend/src/config/moderationWordlist.js`

Pure, dependency-free matcher. Normalises (NFKD, diacritic strip,
zero-width removal, lowercase, run-collapsing), masks the allowlist, then
matches each term with a bounded, anchored, obfuscation-tolerant pattern.

Defeats capitalisation, punctuation between letters, spaces between
letters, repeated characters, leetspeak/symbol substitution, Unicode
lookalikes and zero-width splitting.

Avoids the Scunthorpe problem two ways: `(?<![\p{L}\p{N}])` / `(?![\p{L}\p{N}])`
boundary lookarounds, plus an allowlist masked out *before* matching. 20
legitimate sentences ("assessment", "classic", "cockroach", "therapist",
"Please pass this to the class rep") are asserted clean.

Severity model: a single `low` hit is not a case (or the queue fills with
noise and moderators stop reading it); `high` hides pending review;
`SELF_HARM` is flagged but **never** hidden, because hiding a cry for help
removes it from the thread where someone might answer.

**Evidence:** 72/72 in `backend/tests/textModeration.test.mjs`.

### 2. Admin-managed moderation words — schema + service DONE

`backend/src/services/moderationService.js`, `backend/prisma/sql/10_comment_moderation.sql`

`moderation_words` table, cached merge of built-in + custom terms,
`normalised` unique column so two spellings of one word cannot both be
inserted, and cache invalidation on write.

**The no-redeploy requirement is proven, not assumed.**
`verify-moderation.mjs` inserts a word into the live database, confirms
the matcher picks it up immediately, disables it, confirms it stops
matching, then deletes it:

```
PASS  probe term does not match before being added
PASS  inserted a moderation word via Prisma
PASS  newly added word flags immediately — no redeploy, no restart
PASS  disabling a word stops it matching
```

### 3. Flagging behaviour wired into the request path — DONE

`backend/src/services/ticketService.js`, `backend/src/routes/ticketRoutes.js`

Comment POST and PATCH both run the filter. Status, reason, categories,
severity, `flagged_at` are persisted; hidden comments are excluded in SQL
(not in JS after fetching); `moderation_actions` records the audit trail.

**Evidence:** 7/7 in `moderationService.test.mjs`; migration confirmed
against the live database — 9 columns, 2 tables, moderation index, and a
`CHECK` constraint on `moderation_status` so bad app code cannot write a
state the queue does not understand.

### 4. Rate limiting — DONE

`backend/src/middleware/rateLimiter.js`, documented in `RATE_LIMITS.md`

Per-endpoint limits (not one blanket limit), enforced server-side, keyed
so one abuser cannot lock out a shared NAT. Returns 429 with
`Retry-After` and no sensitive detail.

**Evidence:** 18 tests in `rateLimiter.test.mjs` + `probe-ratelimit.mjs`.

### 5. Mobile notification bell — DONE

`frontend/src/components/Layout.jsx`, `NotificationBell.jsx` — bell now
renders in the mobile header without overlapping other controls.

---

## Two real bugs found by verification

Both were found *because* the work was verified against a live database
rather than only reasoned about. Both would have reached production.

### BUG 1 — a hyphenated moderation word broke all commenting (critical)

A single shared escaper wrote `-` as `\-`. That is valid inside a
character class but an **invalid escape outside one under the `u` flag**,
so `new RegExp` threw:

```
Invalid regular expression: /…\-…/gu: Invalid escape
```

`analyseText` runs on every comment POST, so the moment an admin added any
hyphenated phrase — "kill-yourself" being the obvious one — **comment
posting would have failed portal-wide with a 500.** The unit tests missed
it because no built-in term contains a hyphen.

Fixed by splitting escaping into `escapeInClass` and `escapeLiteral`,
since the two positions have genuinely different rules. Added a
`patternFor` guard so an uncompilable term is skipped and remembered
instead of throwing — admin input becomes a regex here, and that boundary
must degrade one entry rather than fail every request.

### BUG 2 — hyphenated terms only matched the hyphenated spelling (bypass)

After fixing the crash, `kill-yourself` matched only `kill-yourself`:

```
"you should kill-yourself" -> true
"you should kill yourself" -> false   <-- bypass
"killyourself"             -> false   <-- bypass
```

An admin typing a hyphen means "word gap", so hyphen and underscore now
compile to the same optional-separator run as a space. All three spellings
match. This does not weaken `f-u-c-k`, which concerns hyphens in the input
text and is handled by the separator runs between letters.

**Evidence:** 13 new metacharacter regression tests. They assert both that
such terms compile *and* that they are not silently swallowed by the
bad-term guard — `doesNotThrow` alone would have passed a term that never
matched anything.

---

## Test results

| Suite | Result |
|---|---|
| `backend/npm test` (full regression) | **185/185 pass** |
| `textModeration.test.mjs` | 72/72 |
| `verify-moderation.mjs` (live DB) | 18/18 |

No existing test was weakened or removed.

---

## Outstanding — NOT yet implemented

Listed plainly because the task asks for evidence, not claims. None of
these should be described as working:

| # | Item | State |
|---|---|---|
| 2 | Moderation queue **API** (list/approve/reject/resolve) | schema + service ready; routes not written |
| 2 | Flagged-comments **UI** | not built |
| 1 | Word-list CRUD API + admin UI | table + service ready; routes/UI not written |
| 4 | Cloudinary migration | not started; still Supabase Storage |
| 6 | Super Admin manual registration | not started |
| 8 | Contact Developer modal | not started |
| 9 | Feedback tab + admin review | not started |
| 10 | In-app rating prompt | not started |
| 5 | Load tests 100/500/2500/5000 | **not run — no capacity claim is made** |
| 11 | Full security review | partial (rate limits, SQL-level filtering, authz on existing routes) |
| 12 | DB/API performance review | moderation index added; wider review outstanding |
| 13 | Responsive/accessibility review | mobile bell only |

### Explicit non-claims

- **No concurrency claim.** The portal has not been load tested at any
  level, so 100 concurrent students is unproven, let alone 5,000.
- Verification ran against a Supabase instance from one machine. That
  measures correctness, not production capacity.
