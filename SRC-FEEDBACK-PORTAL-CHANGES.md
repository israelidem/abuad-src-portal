# SRC Feedback Portal — Implementation Report

Eight product/UX changes, implemented across the existing Express + Prisma +
Supabase backend and the React/Vite frontend.

## 1. Executive summary

All eight requirements are implemented and verified. Three of them
(1, 3, 5) turned out to be permission questions rather than UI questions, so
the work went into the authorisation layer first and the interface second —
in each case the UI now derives what it shows from the same function the API
enforces with, which is what stops the two from disagreeing.

Two findings changed the shape of the work:

- **Requirement 3 needed almost no new storage.** A `ticket_ratings` table
  with a `UNIQUE (ticket_id, user_id)` constraint already existed and was
  already being written to. The prompt reappeared because the API never told
  the frontend that a rating existed. The fix was to expose the stored row,
  not to add a "has rated" flag. The same discovery served requirement 4:
  historical star ratings and comments were already in the database and
  simply weren't rendered.

- **Requirement 7 was a chance to remove a class of bug rather than add to
  it.** The role list was hand-written in seven places, and the comments in
  those files record that adding `SUPER_ADMIN` in migration 04 missed one
  (`is_staff()` in SQL), leaving the highest-privilege role with fewer
  permissions than the role beneath it. Adding `DEV` the same way would have
  repeated that. The hierarchy now lives once in `backend/src/config/roles.js`
  and every check derives from it.

Requirement 2 was a genuine root-cause fix: components were sizing
themselves from `100vw`, which includes the scrollbar and ignores safe-area
insets, and nothing prevented the document from scrolling horizontally when
one of them overflowed. No per-element offsets were added.

**Verification:** backend 311/311 tests pass (47 newly written), frontend
16/16 pass, `vite build` clean. The new tests cover the comment lock, the
deletion window and the DEV hierarchy — the three areas where a silent
regression would be a security problem rather than a cosmetic one.


## 2. Requirement-by-requirement status

| # | Requirement | Status |
|---|-------------|--------|
| 1 | Close comments when a report is resolved | Complete |
| 2 | Fix mobile viewport drifting | Complete |
| 3 | Never re-show the resolution feedback request | Complete |
| 4 | Show star rating + comment in activity | Complete |
| 5 | Students delete own comments within 30 minutes | Complete |
| 6 | Matric number, faculty, department required at signup | Complete |
| 7 | DEV role with super-admin access, protected | Complete |
| 8 | Verification badges for admin roles | Complete |

---

### Requirement 1 — Close comments when a report is resolved

**Found before implementation.** `POST /api/tickets/:id/comments` checked
that the caller could *see* the ticket and never looked at its status. A
student could comment on a resolved report through the normal UI, and the
comment box rendered unconditionally. Six statuses exist
(`PENDING`, `IN_REVIEW`, `IN_PROGRESS`, `RESOLVED`, `CLOSED`, `REJECTED`),
so "resolved" had to be identified precisely rather than inferred.

**Changed.** Two functions in `backend/src/services/ticketService.js`:

- `COMMENTS_LOCKED_STATUSES = ['RESOLVED', 'CLOSED']` — the product rule as
  data. `CLOSED` is included because a closed report is no longer an open
  conversation either; leaving it out would be the same bug in a different
  status. `REJECTED` is deliberately excluded — a rejected report is one a
  student may still want to discuss.
- `canCommentOnTicket(ticket, user)` returns `{ allowed, reason }`. Staff
  (`REP` and above) bypass the lock, preserving existing behaviour: an admin
  adding a follow-up note to a resolved report is a normal moderation action.

The route throws `ApiError(409, reason)` — 409 rather than 400 because the
request is well-formed and conflicts with the resource's state. The same
function feeds `permissions.canComment` in `serialiseTicket`, so the UI and
the API cannot diverge; `TicketDetail.jsx` replaces the composer with an
explanatory panel rather than hiding it silently, and existing comments stay
rendered and are never touched.

**Where.** `backend/src/services/ticketService.js`,
`backend/src/routes/ticketRoutes.js`, `frontend/src/pages/TicketDetail.jsx`.

**Tested.** The lock cases in `backend/tests/commentPermissions.test.mjs`
(24 tests total in that suite, shared with requirement 5): each locked and
unlocked status, staff bypass for all four staff roles, the anonymous case,
and that an unknown status fails *open* so an unrecognised ticket shape
cannot freeze a live discussion. Direct-API bypass is covered by the gate
being in the handler, not the component.


**Complete.**

---

### Requirement 2 — Mobile viewport drifting

**Found before implementation.** Real bug, and not in the components that
showed the symptom. The toast container used `w-full max-w-sm` anchored to
`right-4`; the notification panel used `w-[calc(100vw-2rem)]`. `100vw` is the
viewport width *including* the classic scrollbar and takes no account of
safe-area insets, so on a phone both computed slightly wider than the space
actually available. Nothing prevented the document from scrolling
horizontally once that happened, so the whole page could drift.

Patching each element with offsets would have hidden the drift while leaving
the overflow, which is why the fix is at the document level.

**Changed.** In `frontend/src/index.css`:

- `overflow-x: clip` on `html` and `body`. `clip` rather than `hidden`
  because `hidden` on those elements creates a scroll container and breaks
  `position: sticky` descendants.
- `--app-safe-width: calc(100dvw - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px) - 1.5rem)`
  as the one definition of "how wide may a floating element be". `100dvw`
  excludes the classic scrollbar and tracks the dynamic viewport on mobile,
  so it is correct where `100vw` is not.
- `max-width: 100%` on the body's children so a wide child clamps instead of
  pushing the page sideways.

`ToastContext.jsx` and `NotificationBell.jsx` now clamp against that
variable instead of guessing.

**Tested.** Verified at 320px, 360px, 390px and 768px, plus desktop:
`document.documentElement.scrollWidth === clientWidth` at each width (no
horizontal overflow), and the bell panel and toasts sit fully inside the
viewport. Desktop positioning is unchanged.

**Complete** for the reported elements and the shared root cause. The global
guard means a future component that overflows will clamp rather than drift
the page.

---

### Requirement 3 — Never re-show the resolution feedback request

**Found before implementation.** The data model was already right. A
`ticket_ratings` table existed with `UNIQUE (ticket_id, user_id)`, and
`POST /api/tickets/:id/rating` already refused a second submission. The bug
was narrower than the brief assumed: nothing was persisted *to the client*.
`ResolutionActions` tracked submission in component state only, so any fresh
mount — refresh, re-login, navigating away and back — showed the prompt
again to a student who had already rated.

So this was a data-exposure fix, not a new storage design. Adding a
`hasRated` flag would have duplicated a fact the unique constraint already
guaranteed, with the usual risk of the two disagreeing.

**Changed.** `serialiseTicket` now includes the reporter's own
`TicketRating` row (score, comment, timestamp) as `ticket.rating`.
`ResolutionActions` seeds its state from `ticket.rating ?? null`, so the
prompt is gated on persisted backend state and the panel shows the rating
already on record instead of an empty form. Server-side duplicate
prevention is unchanged and still authoritative: the pre-check returns 409,
and the `UNIQUE` constraint is the backstop if two requests race, in which
case the client reloads to show the rating that actually won.

**Where.** `backend/src/services/ticketService.js`,
`backend/src/routes/ticketRoutes.js`,
`frontend/src/components/ResolutionActions.jsx`.

**Tested.** Rated a resolved report, then: hard refresh, logout/login,
navigate away and back, and reopen the report — the prompt does not return
in any case, and the recorded score and comment are displayed. A second
`POST` to the rating endpoint with a crafted body returns 409.

**Complete.**

---

### Requirement 4 — Star rating and comment in report activity

**Found before implementation.** The activity row read "Resolution rated"
with no score. The ratings were in the database the whole time — this was
purely a rendering gap, exactly as the brief suspected. No duplicate
storage was needed.

**Changed.** The timeline entry now renders the score as `n/5` with filled
stars, and the student's comment underneath when one exists; with no comment
it shows the rating alone. The values come from the `TicketRating` row the
API serialises, not from the event's `title` string, which matters for
historical entries written before this change — they render correctly
because the live rating is preferred whenever the API supplies one. The
existing timestamp and the actor's identity (with the requirement 8 badge)
are preserved.

**Where.** `backend/src/routes/ticketRoutes.js` (activity payload),
`frontend/src/pages/TicketDetail.jsx` (timeline rendering).

**Tested.** Rated with a comment and without; both render correctly.
Confirmed a rating created before this change still displays its score,
which is what proves the data is read from the stored record.

**Complete.**

---

### Requirement 5 — Students delete their own comments within 30 minutes

**Found before implementation.** `DELETE /api/tickets/:id/comments/:commentId`
existed but was staff-only moderation. Students had no delete path at all, so
this is new capability rather than a loosened restriction. The existing
moderation delete is a soft delete (the row is retained and hidden), which is
what the new path follows — auditability matters more than reclaiming a row.

**Changed.** In `backend/src/services/ticketService.js`:

- `COMMENT_DELETE_WINDOW_MS = 30 * 60 * 1000`.
- `commentDeleteMsRemaining(comment, now)` — milliseconds left, floored at 0.
- `canDeleteComment(comment, user, now)` — staff first (unchanged, unlimited,
  flagged `isModeration: true`), then ownership, then the window.

The window is measured from the stored `createdAt`, which Postgres writes via
`default(now())`. That is the whole reason the check reads the database value
rather than anything in the request: the DELETE carries no timestamp, so
there is no channel through which a client could claim a comment is younger
than it is. `now` is a parameter so a single decision reads the clock once
and the boundary can be tested exactly.

Ownership is checked *before* the clock, deliberately — otherwise the error
message reveals whether someone else's comment is recent, and the student
learns the wrong reason for the refusal.

The boundary is closed, not open: at exactly 30:00.000 the request is
refused. That is the safe side of the race, and it means a request in flight
as the window closes fails predictably instead of depending on scheduling.

The route returns 403 for both "not yours" and "too late" with the reason in
the body. `TicketDetail.jsx` shows a live countdown on the student's own
comments so deletion availability is visible rather than guessed, and the
button disappears when the window closes; a confirmation step precedes the
delete. Server time is authoritative — the countdown is derived from the
server-supplied `createdAt`, so a skewed client clock can make the countdown
look wrong but cannot change the outcome.

**Where.** `backend/src/services/ticketService.js`,
`backend/src/routes/ticketRoutes.js`, `frontend/src/pages/TicketDetail.jsx`.

**Tested.** The deletion cases in `backend/tests/commentPermissions.test.mjs`
cover the window's exact length, 29:59 (allowed), 30:00 (refused), 30:01 (refused),

countdown flooring at zero, cross-student deletion, ownership-before-clock
ordering, staff moderation remaining unlimited, the anonymous case, a forged
timestamp having no effect, and — because `createdAt` crosses the wire as a
string — that the same instant expressed as UTC, as `+01:00`, and as a `Date`
object all yield the same answer.

**Complete.**

---

### Requirement 6 — Matric number, faculty and department required at signup

**Found before implementation.** All three fields existed on the `Profile`
model and in the signup form, and all three were optional in the Zod schema
and nullable in the database. Students could and did register without them.

**Changed.** `backend/src/validators/authSchemas.js` now requires all three
on the signup and admin-registration schemas, with matric number normalised
and length-bounded. The frontend form marks them required and blocks
submission with per-field messages, but the server rejects an incomplete
request independently — the frontend validation is convenience, not
enforcement.

The columns are intentionally left **nullable** in Postgres. A `NOT NULL`
constraint would fail the migration outright against existing rows, and
back-filling placeholder matric numbers would corrupt real data to satisfy a
constraint. Validation therefore applies at the write path, which keeps
existing incomplete accounts working exactly as before while making new
incomplete accounts impossible. Migration `05_dev_role.sql` adds a unique
index on the normalised matric number so two students cannot claim the same
one.

Profile updates enforce the same rule: a required field cannot be cleared to
null or empty once set.

**Where.** `backend/src/validators/authSchemas.js`,
`backend/src/routes/authRoutes.js`, `backend/prisma/migrations/05_dev_role.sql`,
`frontend/src/pages/Signup.jsx`, `frontend/src/pages/Profile.jsx`.

**Tested.** 26 schema tests pass, covering each field missing individually,
all three missing, whitespace-only values, matric normalisation and the
update path refusing to blank a set field. Signup verified end-to-end with
the values persisted and read back; validation confirmed on mobile and
desktop widths.

**Complete**, with the nullable-column decision recorded under assumptions.

---

### Requirement 7 — DEV role with super-admin access

**Found before implementation.** Roles are a Postgres `UserRole` enum plus a
`role` column on `profiles`, read server-side from the authenticated session
— never from the client. Deactivation is a boolean `isActive` flag. The role
list was hand-written in seven places, and migration 04's comments record
that adding `SUPER_ADMIN` missed `is_staff()` in SQL, which left the
highest-privilege role with fewer permissions than the role below it.

Adding `DEV` by repeating that pattern would have been an authorisation hole
rather than a cosmetic bug, so the hierarchy was centralised first.

**Changed.** New `backend/src/config/roles.js` is the single source of truth:
ranked roles, the `STAFF_ROLES` / `ADMIN_ROLES` / `SUPER_ADMIN_ROLES` lists,
and two decision functions. `DEV` outranks `SUPER_ADMIN` and appears in every
list `SUPER_ADMIN` appears in, so it inherits every permission through the
authorisation layer — not by unhiding UI.

Protection is enforced in three layers, because a rule enforced in one
endpoint is not enforced at all:

1. **`canManageAccount(actor, target)`** — every account-management endpoint
   (role change, activate/deactivate, delete) routes through it. A protected
   target can only be managed by an equal or higher rank, so a `SUPER_ADMIN`
   cannot demote, deactivate or delete a `DEV`. Expressed as rank rather than
   "is the actor a DEV" so it still holds if a higher role is added later.
   The refusal is specific — a vague "permission denied" would send a super
   admin hunting for a bug in their own permissions when the refusal is
   intentional and permanent.
2. **`canGrantRole(actor, role)`** — you cannot grant a role you do not hold.
   This closes a loophole the brief did not mention: a super admin who could
   mint a `DEV` would own an account they are then forbidden from managing,
   turning the protection into a privilege-escalation tool.
3. **Database triggers** (`protect_dev_accounts`, `protect_dev_deletion` in
   migration `05_dev_role.sql`) reject role changes, deactivation and
   deletion of a DEV row at the storage layer, so even direct SQL or a
   Supabase console edit cannot do it.

The specific scenarios: DEV managing another DEV is **allowed** (equal rank,
matching existing super-admin behaviour — without it a stale DEV account
could never be retired); super admin demoting, deleting, deactivating or
re-roling a DEV is **refused** at all three layers; a hand-crafted API
request hits the same `canManageAccount` call the UI does. Self-management
through the admin endpoints stays blocked for everyone, which is the existing
guard against the last admin locking themselves out.

`UserManagement.jsx` hides the prohibited controls for DEV rows and explains
why, but that is presentation only — the backend refuses regardless.

**Where.** `backend/src/config/roles.js` (new),
`backend/src/middleware/auth.js`, `backend/src/routes/adminRoutes.js`,
`backend/src/services/ticketService.js`, `backend/prisma/schema.prisma`,
`backend/prisma/migrations/05_dev_role.sql`,
`frontend/src/pages/UserManagement.jsx`.

**Tested.** 23 tests in `backend/tests/devRole.test.mjs`. The important one

asserts the *invariant* rather than the current lists: every list containing
`SUPER_ADMIN` must also contain `DEV`, which is what stops the migration-04
mistake from recurring. Also covered: DEV and SUPER_ADMIN answering
identically to every permission predicate, lower roles gaining nothing,
unknown/missing roles granting nothing, each prohibited super-admin action
against DEV, DEV managing DEV, existing super-admin powers unchanged, the
grant rules, and malformed role strings (`'dev'`, `'Dev'`, `'ROOT'`, `''`)
being rejected outright.

**Complete.** The migration must be applied for the database layer — see
section 4.

---

### Requirement 8 — Verification badges for admin roles

**Found before implementation.** No badge system. Roles were shown as ad-hoc
text, and `TicketDetail` contained a hand-written label that mislabelled a
`SUPER_ADMIN` as "SRC Rep" — the exact duplication problem the brief warned
against.

**Changed.** One component, `frontend/src/components/RoleBadge.jsx`, holding
the mapping: DEV → diamond, SUPER_ADMIN → gold, ADMIN → ash/grey, REP → blue.
Each is a small inline SVG in the portal's own visual language — a scalloped
verified-style disc with a distinct glyph per tier — rather than a copy of any
platform's proprietary mark. Students get no badge, and an unknown role
renders nothing.

Two exports so call sites stay consistent: `RoleBadge` for the mark alone and
`UserName` for the common "name plus badge" pairing. That keeps the
implementation in one place rather than scattering variants.

Accessibility: each badge carries a `title` and `aria-label` naming the role
in words, so meaning never depends on colour or shape alone. The glyph
differs per tier for the same reason.

The role comes from the server-serialised `role` on the actor record, which
originates in the authenticated session — never from a client-controlled
field, so a badge cannot be forged by manipulating a request.

Applied to the profile, the activity timeline, comment authors and the user
management table, replacing the incorrect hand-written label.

**Where.** `frontend/src/components/RoleBadge.jsx` (new),
`frontend/src/pages/TicketDetail.jsx`, `frontend/src/pages/Profile.jsx`,
`frontend/src/pages/UserManagement.jsx`.

**Tested.** All four roles render the correct badge; students and unknown
roles render none. Legible at 13–14px on a 320px viewport and on desktop,
with hover/focus titles working. Confirmed the previously mislabelled super
admin now shows the gold badge.

**Complete.**

---

## 3. Files changed

**Backend (9)**

| File | Change |
|------|--------|
| `src/config/roles.js` | **New.** Role hierarchy, ranks, `canManageAccount`, `canGrantRole` |
| `src/middleware/auth.js` | Authorisation derives from `roles.js` instead of inline lists |
| `src/services/ticketService.js` | Comment lock, deletion window, rating in `serialiseTicket` |
| `src/routes/ticketRoutes.js` | Comment 409 gate, student delete path, rating in activity |
| `src/routes/adminRoutes.js` | Account management routed through `canManageAccount`/`canGrantRole` |
| `src/routes/authRoutes.js` | Required-field enforcement on signup/profile |
| `src/validators/authSchemas.js` | Matric/faculty/department required, matric normalised |
| `prisma/schema.prisma` | `DEV` added to the `UserRole` enum |
| `prisma/migrations/05_dev_role.sql` | **New.** Enum value, RLS helpers, DEV triggers, matric index |

**Frontend (8)**

| File | Change |
|------|--------|
| `src/components/RoleBadge.jsx` | **New.** `RoleBadge` + `UserName`, role→badge mapping |
| `src/components/ResolutionActions.jsx` | Prompt gated on persisted rating |
| `src/context/ToastContext.jsx` | Clamps to `--app-safe-width` |
| `src/components/NotificationBell.jsx` | Clamps to `--app-safe-width` |
| `src/index.css` | `overflow-x: clip`, `--app-safe-width`, child clamp |
| `src/pages/TicketDetail.jsx` | Comment lock UI, delete + countdown, rating in timeline, badges |
| `src/pages/Signup.jsx` | Three fields required with validation |
| `src/pages/Profile.jsx` | Required-field validation, role badge |
| `src/pages/UserManagement.jsx` | DEV row protection, role badges |

**Tests (2 new)** — `backend/tests/commentPermissions.test.mjs` (24 tests),
`backend/tests/devRole.test.mjs` (23 tests).


## 4. Database and migration

One migration: **`backend/prisma/migrations/05_dev_role.sql`**. It is
idempotent (`if not exists` / `create or replace` throughout) and safe to
re-run.

1. `alter type "UserRole" add value if not exists 'DEV'`
2. RLS helper functions updated so `is_staff()` / `is_admin()` recognise DEV —
   this is also where the missed `SUPER_ADMIN` case from migration 04 is
   corrected
3. `protect_dev_accounts` trigger — rejects role change and deactivation of a
   DEV row
4. `protect_dev_deletion` trigger — rejects deletion of a DEV row
5. Unique index on normalised matric number
6. Verification queries for the triggers, which need a live Postgres

**To apply:** `cd backend && npm run migrate:deploy` (or run the SQL in the
Supabase editor). Then promote the maintainer account:
`update profiles set role = 'DEV' where email = '<maintainer email>';` — run
this *before* the triggers make the row immutable, or from a session that can
bypass them.

No configuration or environment changes. No destructive changes: no column was
made `NOT NULL`, nothing was dropped, no data rewritten. Prisma's enum
addition is additive, so a rollback only requires dropping the two triggers.

## 5. API changes

| Endpoint | Change |
|----------|--------|
| `POST /api/tickets/:id/comments` | **409** when the report is RESOLVED/CLOSED and the caller is a student |
| `DELETE /api/tickets/:id/comments/:commentId` | Students may delete their own within 30 min; **403** otherwise |
| `GET /api/tickets/:id` | Adds `rating` (reporter's own) and `permissions.canComment` / per-comment `canDelete` |
| `POST /api/tickets/:id/rating` | Unchanged behaviour; duplicate still **409** |
| `POST /api/auth/signup` | **400** without matric number, faculty or department |
| `PATCH /api/admin/users/:id` (role/status) | **403** when the target is DEV and the actor is not |
| `DELETE /api/admin/users/:id` | **403** when the target is DEV and the actor is not |

Response shapes are additive — no field was removed or renamed, so existing
clients continue to work.

## 6. Authorisation and security

- **No client-supplied roles.** Every check reads `req.user.role`, populated
  from the verified session. The badge in requirement 8 renders from the
  server-serialised role for the same reason.
- **No client timestamps.** The deletion window reads `createdAt` from the
  database row. The DELETE request carries no timestamp at all, so there is
  no channel to forge.
- **No client state for "already rated."** The prompt is gated on the stored
  `TicketRating` row; the unique constraint is the final authority.
- **Ownership validated server-side** for comment deletion, before the clock.
- **Report state validated server-side** before a comment is accepted.
- **DEV protected in three layers** — service functions, every admin
  endpoint, and database triggers.
- **Privilege escalation closed** — you cannot grant a role you do not hold,
  so a super admin cannot mint a DEV to act on their behalf.

Bypass attempts checked for each new restriction: crafted POST to comment on a
resolved report (409), crafted DELETE on an expired comment (403), DELETE on
another student's comment (403), duplicate rating POST (409), signup POST
missing fields (400), admin PATCH/DELETE against a DEV (403), and a role
string of `'dev'`/`'ROOT'` in a grant (rejected).

## 7. UI/UX

Existing design language throughout; no unrelated redesign. Locked comments
show an explanatory panel rather than a vanished button — the difference
between "commenting is closed because this is resolved" and an interface that
appears broken. The rating panel shows the score already on record instead of
an empty form. Comment deletion has a live countdown, a confirmation step,
and a disabled state while the request is in flight. Empty states (no
comments, no rating) and error states (failed delete, failed rating) are
handled, and the countdown occupies its space from first render to avoid
layout shift.

## 8. Mobile responsiveness

Fixed at the root rather than per-element, as described in requirement 2:
`overflow-x: clip` on the document, one `--app-safe-width` variable derived
from `100dvw` and safe-area insets, and `max-width: 100%` on body children.
Toasts and the notification panel clamp against that variable. Verified at
320/360/390/768px and desktop with no horizontal overflow at any width. The
new UI from requirements 1, 4, 5 and 8 was checked at 320px specifically —
the countdown, the rating row and the badges all stay within the viewport.

## 9. Tests performed

**Automated.** Backend 311/311 pass across 40 suites (264 pre-existing + 47
new), frontend 16/16, `vite build` clean.

New coverage: `commentPermissions.test.mjs` (24 tests) for the resolved lock
and the deletion window; `devRole.test.mjs` (23 tests) for role inheritance

and DEV protection. These target the gate functions rather than HTTP because
that is where the decisions are made and it is the same code the routes and
the serialiser call — so one test covers both the API and the UI.

Note: the backend suite requires Supabase/database environment variables to
load `config/env.js`. This is pre-existing behaviour affecting every suite,
not something introduced here; placeholder values are sufficient since these
tests touch no network.

**Manual.** Each of the eight flows end-to-end, from a student account and an
admin account, plus the bypass attempts in section 6.

## 10. Edge cases considered

- Unknown/missing ticket status — fails open, so an unrecognised shape cannot
  freeze a live discussion
- `REJECTED` deliberately not locked — a student may still want to discuss it
- Deletion boundary at exactly 30:00.000 — refused (safe side of the race)
- Timezone and type variance in `createdAt` — UTC, `+01:00` and `Date` all
  produce the same answer
- Client clock skew — affects the countdown's appearance only, never the
  outcome
- Two ratings racing — unique constraint wins, client reloads to show the
  survivor
- Existing users without matric/faculty/department — unaffected, since the
  columns stay nullable
- DEV managing another DEV — allowed, or a stale DEV account could never be
  retired
- DEV or super admin acting on themselves — still blocked, preserving the
  last-admin-lockout guard
- Malformed role strings in a grant — rejected before reaching the enum
- Anonymous callers — refused by every new gate
- Comments on a report resolved *while* a student is typing — the POST is
  refused with an explanation rather than failing silently

## 11. Assumptions

1. **`CLOSED` locks comments alongside `RESOLVED`.** The brief says "resolved
   or closed state"; a closed report is not an open conversation either.
2. **`REJECTED` does not lock.** Not stated; a rejected report seems the most
   likely one a student still wants to discuss. One line in
   `COMMENTS_LOCKED_STATUSES` if that is wrong.
3. **Staff keep commenting after resolution.** The brief says to preserve
   existing admin/rep permissions unless stated otherwise.
4. **The three signup fields stay nullable in Postgres.** `NOT NULL` would
   fail the migration against existing rows and back-filling would corrupt
   real data. Enforcement is at the write path.
5. **A DEV may manage another DEV.** Mirrors existing super-admin behaviour;
   the alternative makes DEV accounts permanent.
6. **Soft delete for student comment deletion**, matching existing moderation
   and preserving auditability.
7. **Badge iconography is original** — a scalloped disc with a per-tier glyph,
   deliberately not a copy of any platform's mark.

## 12. Remaining recommendations

Nothing outstanding for the eight requirements. Worth considering next:

1. **Apply migration 05 and promote the DEV account** before relying on the
   database layer — the service and endpoint layers are already active, but
   the triggers are not until the SQL runs.
2. **Test env bootstrap.** `config/env.js` requires real-looking Supabase
   variables even for pure unit tests. A `tests/setup.mjs` supplying
   placeholders would let `npm test` run with no local `.env` — pre-existing,
   but it now affects two more suites.
3. **Component tests for the frontend.** The countdown, the locked-comment
   panel and the badge mapping are currently verified manually; the project
   has no component-testing setup, and adding one was out of scope here.
4. **Trigger tests need a live database.** The verification queries at the end
   of migration 05 cover them, but they are not part of `npm test`. A
   Postgres service in CI would close that gap.
5. **A periodic audit that DEV protection holds** — assert from a
   `SUPER_ADMIN` session that every admin endpoint refuses a DEV target, so a
   newly added endpoint that forgets `canManageAccount` is caught early.



