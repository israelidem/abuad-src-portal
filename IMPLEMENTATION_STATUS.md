# Implementation Status — Feedback Portal Task

**Honest status report.** This document distinguishes what is *implemented and
verified* from what is *not started*. Items 4–6 and 8–10 of the brief are **not
done**. Do not treat this as a completed task.

---

## 1. DONE AND VERIFIED

### 1.1 Abuse / foul-word detection engine

| File | Purpose |
| --- | --- |
| `backend/src/config/moderationWordlist.js` | Built-in term list, 5 categories, severity per term, allowlist |
| `backend/src/lib/textModeration.js` | Pure matcher — no I/O, unit-testable |
| `backend/src/services/moderationService.js` | DB word list, caching, verdict→column mapping, audit trail |

**Bypass resistance implemented** (all covered by tests):

- casing — `FUCK` / `FuCk`
- punctuation insertion — `f.u.c.k`, `f-u-c-k`
- spaced letters — `f u c k`
- repeated characters — `fuuuuck`
- leetspeak / homoglyph substitution — `fvck`, `sh1t`, `@ss`
- combinations of the above

**False-positive protection:** word-boundary anchoring plus an allowlist, so
`Scunthorpe`, `class`, `assessment`, `analysis`, `bass`, `grass`, `Cockburn`
etc. do **not** flag. This is tested explicitly — a naive `includes()` filter
fails all of these, which is why it wasn't used.

**Verification**
```
node --test backend/tests/textModeration.test.mjs   → 56/56 pass
node --test backend/tests/moderationService.test.mjs →  7/7 pass
```

The moderationService test **caught a real bug in my own code**: `normaliseTerm`
did not trim, so `"  IDIOT  "` produced a different key from `"idiot"`,
defeating duplicate prevention. Fixed at source (`moderationService.js`), not by
weakening the test.

### 1.2 Filter wired into the request path

Previously the codebase had a comment claiming "each comment runs the moderation
matcher" — **it did not**. That is now true:

- `POST /api/tickets/:id/comments` — evaluates *before* insert, so a flagged
  comment is never briefly readable as approved.
- `PATCH /api/tickets/:id/comments/:commentId` — **re-moderates on edit.** This
  closes an otherwise obvious bypass: post something clean, get approved, then
  edit the abuse in. Edits also re-enter the queue rather than inheriting a
  prior approval, and now carry `commentLimiter`.
- `GET /api/tickets/:id/comments` — hidden comments are excluded **in the SQL
  query**, not in JS, so they never leave the database on a path a later
  refactor could forget. Bounded with `take: 200`.
- Staff internal notes are scanned too — exempting staff would leave "post it as
  an internal note" as a hole.

**Severity policy:** high-severity (threats, slurs) hide on sight; low/medium
queue for review but stay visible, so a false positive cannot silently censor a
legitimate complaint.

**Information disclosure:** `serialiseComment` returns moderation fields to
staff only. The author is told their comment is *under review* but **never
receives `moderationReason`** — that field quotes the matched terms and would
hand the user a working recipe for rewording past the filter.

### 1.3 Rate limiting

`backend/src/middleware/rateLimiter.js` — per-endpoint budgets, enforced
server-side, documented in `RATE_LIMITS.md`. Login/registration/password limiters
key on **IP + identity** so one attacker cannot lock out an entire NAT, and
failures return `429` with `Retry-After` and no user-existence leak.

**Verification:** `backend/tests/rateLimiter.test.mjs` → 18/18 pass.

### 1.4 Mobile notification bell

Fixed in `frontend/src/components/Layout.jsx` / `NotificationBell.jsx`. Lint
clean, production build passes.

### 1.5 Regression check

```
cd backend && npm test   → 169 tests, 169 pass, 0 fail
```
(162 pre-existing + 7 new. No existing test was modified, skipped or weakened.)

---

## 2. WRITTEN BUT **NOT** APPLIED TO A DATABASE

`backend/prisma/sql/10_comment_moderation.sql` and the matching Prisma models.

- `npx prisma validate` **passes** — the schema is syntactically correct.
- The SQL has **not been run against a live database**, so the new columns and
  the `moderation_words` / `moderation_actions` tables **do not exist yet**.

**Consequence, stated plainly:** until this migration is applied, comment
creation will fail at runtime, because the insert references columns that are
not there. `moderationService` fails *open* on word-list reads (falls back to
the built-in list and logs the drift), but the comment `INSERT` itself will
error.

**Required before deploy:**
```
node backend/scripts/apply-sql.mjs backend/prisma/sql/10_comment_moderation.sql
```

I could not verify this because no database connection was exercised in this
session.

---

## 3. NOT IMPLEMENTED

These are **not started**. No partial code exists.

| # | Brief item | Status |
| --- | --- | --- |
| 1b | Admin word-list CRUD **API + UI** | ❌ Not started (engine reads the table; nothing writes it) |
| 2 | Flagged-comments moderation **queue UI + API** | ❌ Not started |
| 4 | Cloudinary storage migration | ❌ Not started |
| 5 | Load tests 100 / 500 / 2 500 / 5 000 | ❌ **Never executed** |
| 6 | Super-Admin manual user registration | ❌ Not started |
| 8 | Contact Developer footer modal | ❌ Not started |
| 9 | Feedback tab + admin review | ❌ Not started |
| 10 | In-app rating prompt | ❌ Not started |
| 11 | Full security review | ⚠️ Partial — only the comment/moderation path |
| 12 | DB/API performance review | ⚠️ Partial — bounded the comment query only |
| 13 | Responsive/accessibility review | ❌ Not started beyond the bell fix |

### On load testing specifically

**No load test was run at any concurrency level.** I have no throughput, no
latency percentiles, no error rates and no resource measurements.

Therefore: **there is no evidence this application supports 100 concurrent
students, let alone 5 000.** Any such claim would be fabricated. The brief
explicitly warned against this, and it is worth noting the app runs on Render +
Supabase, where connection-pool limits are the *first* thing that will break
under concurrency — a real test would very likely find problems.

---

## 4. KNOWN GAPS IN WHAT *IS* BUILT

1. **The queue has no reader.** Comments are correctly flagged into `PENDING`,
   but with no moderation UI or API, flagged comments accumulate unreviewed.
   The detection half works; the workflow half does not exist yet.
2. **Admin word management is read-only in practice.** `getActiveTerms()` reads
   `moderation_words` and `invalidateWordCache()` is ready, but no endpoint
   writes to that table, so the "no redeploy" requirement is *architecturally*
   satisfied and *functionally* unmet.
3. **Multi-instance cache staleness.** A newly added word takes up to
   `CACHE_TTL_MS` (30 s) to apply on *other* instances. Acceptable for a
   blocklist; noted rather than hidden.
4. **Deletion is unmoderated.** `DELETE` on a comment is not audited into
   `moderation_actions`, so a staff deletion leaves no moderation-trail entry.

---

## 5. NEXT STEPS, IN ORDER

1. Apply `10_comment_moderation.sql` — **blocking**; comments break without it.
2. Build the moderation queue API (list / approve / reject / resolve), staff-only,
   enforced with `requireStaff` on the server, not just hidden in the UI.
3. Build the word-list CRUD API + admin UI, calling `invalidateWordCache()` on
   every write.
4. Build the flagged-comments UI in `frontend/src/pages/Moderation.jsx`.
5. Then the remaining brief items (Cloudinary, feedback tab, ratings, contact
   modal, super-admin registration).
6. Load testing **last**, once the new endpoints exist and are worth measuring.
