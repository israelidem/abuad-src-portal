# Remaining work — handoff

Five sections of the brief are unstarted. This is the file-level plan for each,
written now while the architecture is fresh, so the next session can begin
implementing immediately instead of re-deriving it.

Conventions already established in this codebase, which all five should follow:

- **Migrations**: numbered SQL in `backend/prisma/sql/`, applied with
  `node scripts/apply-sql.mjs`. Next free number is `11_`.
- **Routes**: `requireAuth` → role guard → rate limiter → zod validator →
  service. Never trust the client for role or ownership.
- **Validation**: zod schemas in `backend/src/validators/`.
- **Rate limits**: add the limiter in `backend/src/middleware/rateLimiter.js`
  and document it in `RATE_LIMITS.md`.
- **Tests**: `backend/tests/*.test.mjs`, node:test, no framework.
- **Audit**: state changes go through `auditService`.

---

## §6 Super Admin manual registration — smallest, do this first

**Backend**

- `POST /api/admin/users` in `backend/src/routes/adminRoutes.js`, behind
  `requireAuth + requireSuperAdmin + adminWriteLimiter`.
- Must bypass the public signup gate. `registrationPolicy.js` closes public
  signup; this path is a *different* decision and must not consult it — that
  is the whole point of the feature. Add a test that asserts creation still
  succeeds while `registrationOpen` is false, since that is the requirement
  most likely to regress.
- Role is assigned by the caller but must be validated against the enum, and a
  SUPER_ADMIN creating another SUPER_ADMIN deserves an explicit audit entry.
- Reuse the existing duplicate handling: the error handler already maps unique
  violations to 409 with copy that does not identify the other account.
- Password: either generate one and force reset on first login, or accept one
  and hash it through the same path as signup. Do not invent a second hashing
  route.

**Frontend** — `frontend/src/pages/UserManagement.jsx`: `Add New User` button,
modal form. Gate the button on `isSuperAdmin`, but treat that as cosmetic; the
server check is the real one.

**Test**: creation while public signup is closed; a plain ADMIN calling the
endpoint gets 403; duplicate email gets 409.

---

## §9 Feedback tab

**Migration `11_feedback.sql`**: `feedback` table — id, user_id (nullable if
anonymous feedback is allowed), category enum
(GENERAL/SUGGESTION/BUG/USABILITY/OTHER), body, attachment_url, status enum
(NEW/IN_REVIEW/RESOLVED/CLOSED), created_at, updated_at. Index on
`(status, created_at)` for the admin queue.

**Reuse, do not duplicate**: run submitted feedback through
`moderationService` exactly as comments are. Feedback is user-generated text
with the same abuse surface, and a second filter would drift from the first.

**Rate limit**: this is explicitly called out in the brief. Something like 5
per hour per user — enough for a genuinely frustrated student, not enough to
flood the queue.

**Frontend**: submission page plus an admin review section. The admin list must
be paginated; an unbounded feedback list is the same mistake as an unbounded
comment list.

---

## §10 Rating prompt

**Migration `12_ratings.sql`**: `ratings` — user_id, stars 1–5, reason,
created_at, app_version. Unique constraint on `(user_id, period)` or a
"one rating per N days" rule, otherwise the same user can submit repeatedly
and skew the average.

**Trigger logic** is the delicate part. The brief says not immediately after
login and not repeatedly annoying. Persist the dismissal server-side, not in
localStorage — localStorage means the prompt reappears on every new device,
which is precisely the annoyance being guarded against.

Suggested rule: show after N sessions or M minutes of cumulative use, then on
dismiss set a "do not ask again until" timestamp.

**Admin**: average, distribution, recent comments. Aggregate in SQL, not by
pulling every row into Node.

---

## §4 Cloudinary migration

Current storage is Supabase Storage; the client path is
`frontend/src/lib/uploads.js` and `frontend/src/components/AttachmentPicker.jsx`.

- Credentials belong in backend env only. The upload must be **signed
  server-side** — putting an unsigned preset in the frontend hands anyone the
  ability to upload to your account.
- Validate type and size on the **server**. Client-side checks are a courtesy
  to the user, not a control.
- Deletion path matters: when a ticket or comment is removed, its asset should
  go too, or the account slowly fills with orphans nobody can account for.
- **Migration question to answer before writing code**: do existing Supabase
  files need moving, or can both be read during a transition? Decide
  explicitly; a half-migrated store where some URLs resolve and some do not is
  worse than either end state.

---

## §5 Load testing

Needs, in order:

1. A tool — `autocannon` (npm, simplest) or k6 (better for multi-step flows).
2. A seeded database with realistic row counts. Testing against an empty table
   measures nothing: index behaviour only appears with volume.
3. A target that is not a dev server. `vite`/`node --watch` numbers are not
   production numbers.

Model **workflows**, not single endpoints: login → dashboard → list tickets →
open one → comment. Hammering one route repeatedly gives a number that looks
authoritative and predicts nothing.

Run 100 → 500 → 2,500 → 5,000 in that order and stop at the first level that
degrades; there is no value in the higher tiers until the lower one is clean.

**First place to look**, based on code inspection only: the moderation regex
set runs per comment submission. It is cheap against the built-in list but
unmeasured against a large admin-managed one. If it shows up hot, precompile
one alternation per severity rather than one regex per term.

**Second**: rate limiting is in-process. Under multiple instances the limits
are per-instance, which also means load-test numbers taken on one instance
will not extrapolate.

---

## What must not be claimed

Until §5 is actually executed, the portal has **no** verified concurrency
figure. Not 5,000, not 100. Everything above is a hypothesis derived from
reading the code, and the point of the test is that reading is not measuring.
