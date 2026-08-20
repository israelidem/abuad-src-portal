# ABUAD SRC Portal — Production Hardening Report

Everything below was executed and observed, not inferred. Where something is
untested, it says so explicitly.

**Verification at completion**
- Backend tests: **88 pass, 0 fail**
- Frontend tests: **16 pass, 0 fail**
- `eslint src`: **0 problems**
- `vite build`: **clean, built in 19.4s**
- Live observability checks (`verify:observability`): **14 pass, 0 fail**
- Audit trail round-trip (`verify:audit`): **13 pass, 0 fail**
- Database protections (`verify:rls`): **21 pass, 0 fail**

---

## 1. Files changed

**Backend — new**
| File | Purpose |
|---|---|
| `src/config/settingsRegistry.js` | Single manifest describing every setting |
| `src/services/registrationPolicy.js` | Signup gate, fails open |
| `src/services/authCache.js` | Short-TTL token→profile cache |
| `src/lib/logger.js` | Structured JSON logging with credential redaction |
| `src/middleware/requestContext.js` | Request IDs + access logging |
| `src/services/auditService.js` | Shared audit trail with before/after diff |
| `prisma/sql/06_security_hardening.sql` | Privilege-escalation fix + RLS |
| `prisma/sql/07_signup_control.sql` | Signup toggle columns |
| `prisma/sql/08_settings_registry.sql` | Settings columns |
| `prisma/sql/09_storage_anonymous.sql` | Storage RLS + anonymous visibility |
| `scripts/apply-sql.mjs`, `inspect-settings.mjs`, `measure-latency.mjs`, `verify-*.mjs`, `delete-user.mjs` | Verification tooling |
| `tests/*.test.mjs` (7 files) | Authorization, uniqueness, settings, visibility, cache, observability |

**Backend — modified**
`server.js`, `middleware/auth.js`, `middleware/errorHandler.js`,
`middleware/maintenance.js`, `routes/authRoutes.js`, `routes/adminRoutes.js`,
`routes/ticketRoutes.js`, `routes/announcementRoutes.js`,
`routes/notificationRoutes.js`, `services/settingsService.js`,
`services/ticketService.js`, `services/pushService.js`,
`validators/authSchemas.js`,
`validators/settingsSchemas.js`, `validators/ticketSchemas.js`,
`prisma/schema.prisma`, `package.json`

**Frontend — new**
`src/lib/imageCompression.js`, `src/pages/DepartmentManagement.jsx`,
`tests/imageCompression.test.mjs`

**Frontend — modified**
`src/App.jsx`, `src/components/Layout.jsx`, `src/components/Spinner.jsx`,
`src/components/AttachmentPicker.jsx`, `src/context/ThemeContext.jsx`,
`src/lib/api.js`, `src/lib/uploads.js`, `src/pages/Analytics.jsx`,
`src/pages/NewTicket.jsx`, `src/pages/Signup.jsx`,
`src/pages/PortalSettings.jsx`, `package.json`

**Docs:** `DEPLOYMENT.md` (new), this report.

---

## 2. Database migrations

Four idempotent SQL files, applied via `npm run sql:apply`. All are additive —
**no destructive migration was written or run, and no data was deleted.**

| File | Contents |
|---|---|
| `06_security_hardening.sql` | Role-change trigger, rewritten `profiles` policies, RLS on votes/ratings/notifications/attachments |
| `07_signup_control.sql` | `allow_student_signups`, `signup_closed_message` |
| `08_settings_registry.sql` | Registry-backed settings columns |
| `09_storage_anonymous.sql` | Storage bucket policies, anonymous-ticket visibility |

---

## 3. RLS policies changed

The audit's suspicion was correct, and worse than described: `profiles_update_own`
used `USING (auth.uid() = id)` with **no `WITH CHECK`**, so a student could
`update({ role: 'SUPER_ADMIN' })` directly against PostgREST and succeed.

Fixed at the database level, defence in depth:

1. **Trigger `trg_protect_profile_columns`** → `protect_profile_privileged_columns()`
   — the real boundary. A `BEFORE UPDATE` trigger comparing `OLD` to `NEW` on
   `role`, `is_active`, `id`, `email`, `email_verified_domain` and
   `department_id`, raising `42501` on any change. Server-side writes
   (Prisma, migrations) pass through, since those are already gated by
   `requireAdmin`/`requireSuperAdmin`; a super admin acting through the
   client is also allowed, so the trigger can never lock the portal's owner
   out. `SECURITY DEFINER`, so its helper calls don't run with the caller's
   rights. A trigger beats a `WITH CHECK` predicate here because it still
   fires on paths a policy expression can miss.
2. **Rewritten policies** with explicit `WITH CHECK`.
3. **Column grants** narrowed to genuinely user-editable fields.
4. **API** strips `role`/`isActive` from update payloads.

Also enabled/corrected RLS on `ticket_votes`, `ticket_ratings`,
`notifications` and `ticket_attachments` — confirmed live on **all 17 public
tables**, with every `UPDATE`/`ALL` policy carrying a `WITH CHECK`.

Storage writes are ownership-scoped. **Read access is deliberately public**,
because the issue board is viewable while logged out and the client renders
`getPublicUrl()` links; making the bucket private would break the board and
force signed URLs throughout. The protection for anonymous attachments is
therefore path unguessability plus scoped writes, not secrecy of the bucket.

**Verified** by executing the attack as a real student JWT — rejected at the
database. Regression-tested in `tests/identityUniqueness.test.mjs`.

---

## 4. New settings

A **registry** (`settingsRegistry.js`), not scattered booleans — one entry
defines label, help text, type, default and validation; API, validator and
admin UI all derive from it. Adding a setting is a one-line change.

Groups: General (portal name, support email, maintenance mode + message),
Registration (student signups, closed message, matric requirement, domain
rules), Tickets (anonymous submissions, max attachments).

Deliberately **not** implemented: session duration, rate-limit tuning,
auto-close timers. Each needs infrastructure this codebase doesn't have yet;
shipping dead toggles that silently do nothing is worse than omitting them.

---

## 5. Security vulnerabilities fixed

| Severity | Issue | Fix |
|---|---|---|
| **Critical** | Privilege escalation via `profiles.role` | Trigger + policies + column grants + API stripping |
| **High** | Private tickets readable via crafted query params | Server-side scope, `includePrivate` ignored for students |
| **High** | Anonymous attachment paths leaked author identity | `anon/<uuid>/<uuid>` paths; policy enforces the shape |
| **Medium** | Votes/ratings/notifications writable cross-user | RLS with ownership checks |
| **Medium** | Account enumeration on signup | Uniform messages (test asserts the wording) |

---

## 6. Bugs fixed

1. **Anonymous tickets invisible to admins** — the actual cause was a
   visibility filter that excluded anonymous rows from staff queries, *not*
   `author_id`. `author_id` was preserved. Admins now see them, identity stays
   hidden from everyone else, and unmasking remains a reason-required,
   audited, ADMIN-only action.
2. **Skeleton loaders rendering as nothing** — `dark:bg-slate-700${className}`
   was missing a space, producing `dark:bg-slate-700h-5`. Tailwind never emits
   that class, so every skeleton silently lost its dark background *and* its
   first utility — usually the height — collapsing to 0px. One character.
3. **Theme switcher inconsistency** — `prefersDark()` was read during render
   while a listener mutated `<html>` directly, so `resolved` went stale and
   consumers (charts most visibly) styled for the wrong theme. Replaced with
   `useSyncExternalStore`, which cannot tear.
4. **Department management unreachable** — full admin CRUD existed in the API
   with no UI, so the routing backbone of every ticket could only be changed
   via direct database access. Built the page; wired route + nav.
5. **Anonymous submissions with attachments were failing at upload** — found
   during the final review, not by reasoning about the code. Migration
   `09_storage_anonymous.sql` had never been applied to the database, so the
   only `INSERT` policy on the bucket was the owner-scoped one requiring
   `foldername[1] = auth.uid()`. The client, correctly, uploads anonymous
   files to `anon/<uuid>/<uuid>` — which fails that check. Identified tickets
   worked, anonymous ones with an image did not. Applied the migration
   (6/6 statements); `verify:rls` went 20/21 → 21/21.

---

## 7. Performance

Measured with `scripts/measure-latency.mjs` rather than guessed.

Problem B was **not** Render. Every authenticated request made a blocking
round-trip to Supabase Auth to resolve the token, then a second for the
profile — serialised, on every call. Added `authCache.js`: a short-TTL cache
keyed by a **hash** of the token (never the token itself), capped by the
token's own expiry, and fully invalidated per-user on role/status change.

Cold start is addressed by deployment (§13), not code.

---

## 8. Notifications

Traced end to end. Records were being created correctly; the unreliability was
in delivery and subscription handling, not creation. Fixes to
`pushService.js`, subscription storage, and the service worker's click→route
mapping. **Push delivery to a physical device was not verified by me** — that
needs a real browser with granted permission and configured VAPID keys. The
in-app path (record → bell → unread count → mark read) is verified.

---

## 9. Storage & compression

Audited first, per instruction — **no storage migration performed.** Cloudinary
remains prepared-for, not adopted; switching would mean new credentials and a
signing endpoint for a cost problem that isn't yet real.

Client-side compression (`imageCompression.js`) resizes and re-encodes before
upload, with a preview of the compressed result. Settings chosen to keep
screenshot text and campus evidence legible rather than to minimise bytes —
these are evidence, not thumbnails. HEIC is skipped (most browsers can't decode
it) rather than silently corrupted. Dimensions, compressed size, MIME type and
attachment count are all enforced. 16 tests cover the edges.

---

## 10. Observability

The audit was right that a failure here was undiagnosable. Four things were
missing, and each was fixed at the layer that actually produces the evidence.

**Structured logging** (`lib/logger.js`) — JSON in production, readable lines
in development. A recursive redaction filter drops anything credential-shaped
(`password`, `*token*`, `authorization`, `*key*`, push `endpoint`/`keys`)
before serialisation, because routes now log whole error and context objects.
It also flattens `Error` instances — `JSON.stringify(new Error('x'))` is
`'{}'`, which is precisely how "something went wrong" becomes the only thing
in a log file — survives circular references, and caps long strings and arrays
so a campus-wide broadcast can't flood the drain.

**Request correlation** (`middleware/requestContext.js`) — every request gets
an ID (honouring an upstream `X-Request-Id` so a trace spans proxy hops),
returned as a response header *and* in error bodies. A student reporting "it
failed" can now quote a number that finds the exact request.

**Failure logging where it silently failed before** — push delivery,
notification creation, ticket events, settings fallbacks and announcement
fan-out all previously swallowed errors. They now record cause and context
while remaining non-fatal.

**Audit trail** (`services/auditService.js`) — `audit_logs` already existed but
was write-only, route-local and `catch {}`-silent. Now shared, so ticket
actions can use it; readable via `GET /api/admin/audit` (SUPER_ADMIN only —
the trail names admins and can expose anonymous authors); and `changes()`
produces the brief's previous/new value diff, recording **only** fields that
actually moved so one real edit isn't buried in a re-submitted form. Identity
fields (`matricNumber`, `authorId`) are never recorded — a matric number in an
admin-readable log would deanonymise an anonymous ticket.

Ticket status changes and assignments are recorded in the existing
`TicketEvent` timeline, which already carries actor, from, to and timestamp;
duplicating them into `audit_logs` would double-write the same facts.

---

## 11. Tests added

32 new tests across 8 files, aimed at the security boundaries:

- **Authorization** — client-supplied `role` stripped at signup; `isActive`
  unsettable via profile update
- **Ticket visibility** — student can't widen scope with `includePrivate=true`
  or by spoofing `scope`; admin listing genuinely isn't restricted to the
  public board; another student learns nothing about an anonymous author
- **Uniqueness** — duplicate messages don't identify the other account
- **Settings** — every setting has a default and the defaults **fail open**;
  a missing settings row leaves signups open rather than locking out the campus
- **Auth cache** — raw tokens aren't used as keys; entries never outlive the
  token; all sessions for a user clear together
- **Observability** — redaction holds across case and nesting; `Error`s don't
  flatten to `{}`; circular references don't throw; the audit diff records
  both sides and omits unchanged and identity fields

Two verification scripts check what unit tests structurally cannot — that the
middleware is actually *wired in*, since a logger nobody calls passes every
test it has:

| Script | Checks |
|---|---|
| `npm run verify:observability` | Request IDs present, distinct, upstream-honoured; error bodies quote the ID; `/api/admin/audit` rejects unauthenticated and forged tokens; no secrets in public settings |
| `npm run verify:audit` | Writes a probe row through the real `recordAudit()`, reads it back, asserts the before/after diff survived the JSON round-trip, then deletes it |
| `npm run verify:rls` | Asks the *database* what is actually in force: the profile guard is attached, enabled, `BEFORE UPDATE` and `SECURITY DEFINER`; RLS on every public table; every `UPDATE` policy has a `WITH CHECK`; storage writes scoped and `anon/` uploads permitted |

`verify:audit` earned its place immediately: it caught that audit writes were
landing but my first probe used the wrong call signature, and — because audit
writes are deliberately non-blocking — nothing else would have reported it.
Run against the live database, it prints real entries with real values
(`user.role_change  STUDENT → ADMIN`).

`verify:rls` earned its place faster: on its first run it found the unapplied
storage migration above. Nothing in the code could have revealed that — the
SQL file sits in the repo looking authoritative while the database knows
nothing about it, and every unit test still passes. **A migration that exists
is not a migration that is applied**, and that gap is invisible from the
application side. It also corrected me twice: my first draft asserted the
bucket must be private (it is public-read by design) and guessed table names
that don't exist, reporting `comments`/`votes`/`ratings` as "not present" —
which reads as reassurance and verifies nothing.

---

## 12. Remaining known issues

1. **Push notifications unverified on a real device** (§8).
2. **Auth cache TTL is a trade-off.** A role change invalidates immediately,
   but a change made directly in the database bypasses invalidation and takes
   up to the TTL to apply.
3. **Settings deliberately omitted** (§4).
4. **Cloudinary not adopted** (§9).
5. **`window.confirm` on department removal** matches existing pages; a styled
   dialog would be better but changing it portal-wide was out of scope.

---

## 13. Deployment

`DEPLOYMENT.md` documents the plan. The Express app was checked for
serverless compatibility before recommending anything: no long-running
processes, no in-memory state that matters, no background jobs. Web Push is
request-scoped, so it survives the model.

The one real incompatibility is **synchronous broadcast fan-out** on
announcements, which can exceed a serverless invocation limit on a large
campus. Documented as the thing to fix before it becomes a production
incident, not silently migrated.

---

## 14. Manual configuration required

Nothing here is automatic.

**Supabase**
1. Apply `prisma/sql/06`–`09` with
   `node scripts/apply-sql.mjs prisma/sql/<file>` (or paste into the SQL
   editor), in order. All idempotent. **Already applied to the current
   database** — `06`–`08` earlier, `09` during the final review.
2. Run `npm run verify:rls` after any schema change. It should report
   **21 passed, 0 failed**; a failure names the file to apply.
3. Leave the attachments bucket **public-read** — the board depends on it.
   Keep `file_size_limit` and the image-only `allowed_mime_types` in place,
   since Storage enforces those regardless of policy.

**Backend env** — `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
Push silently no-ops without these.

**Vercel/Render** — see `DEPLOYMENT.md`.

**Cloudinary** — nothing to do; not adopted.

---

## Two things worth your attention

**The skeleton bug was one missing space** and it had disabled dark mode on
every skeleton while collapsing them to zero height. It's a good argument for
running the linter over template literals that build class strings.

**The privilege-escalation hole was real and trivially exploitable** — a
single `supabase.from('profiles').update({ role: 'SUPER_ADMIN' })` from any
signed-in student's browser console. If this portal has been reachable by
students with the old policy in place, I'd audit `profiles` for unexpected
`SUPER_ADMIN`/`ADMIN` rows and any `audit_logs` gaps around them before
treating the incident as closed. The fix stops it happening again; it can't
tell you whether it already did.
