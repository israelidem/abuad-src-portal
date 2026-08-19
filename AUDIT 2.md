# ABUAD SRC Portal — Technical Audit (Part 2 of 5)

> **Scope of this file:** Backend / Node API · Authentication · Authorization / RBAC · Supabase Database · Row Level Security
> **Prev:** `AUDIT 1.md` · **Next:** `AUDIT 3.md`

---

## 5. Backend / Node API Audit

### 5.1 Server bootstrap & middleware order

`CONFIRMED` from `backend/server.js`:

Middleware chain (in order):
1. `helmet()` — security headers on API responses.
2. `cors({ origin: allowlist })` — origin allowlist from env (`CLIENT_URL` / `CORS_ORIGINS`).
3. `compression()` — gzip.
4. `express.json({ limit: ... })` — JSON body parsing **with a size limit** (good; prevents unbounded payloads).
5. `GET /health` — liveness/DB check (returns 503 if Postgres unreachable).
6. `app.use('/api', apiLimiter)` — global API rate limiter.
7. `app.use('/api', maintenanceGuard)` — maintenance-mode gate ahead of routers, so every mutating endpoint is covered.
8. Routers: `/api/auth`, `/api/tickets`, `/api/departments`, `/api/notifications`, `/api/announcements`, `/api/admin`.
9. 404 handler, then centralized `errorHandler`.
10. Graceful shutdown on `SIGTERM`/`SIGINT` (disconnect Prisma).

This ordering is correct: security → CORS → parse → health → rate limit → maintenance → routes → errors.

### 5.2 Complete route inventory

`CONFIRMED` — extracted programmatically from `backend/src/routes/*.js`. Middleware column shows the guards/validators actually applied per route. "Direct-DB reachable?" flags whether the same operation is *also* possible straight from the browser via PostgREST/Storage (governed only by RLS), which matters for the threat model.

**`/api/auth`** (`authRoutes.js`)

| Route | Method | AuthN | AuthZ | Validation | Notes |
|---|---|---|---|---|---|
| `/check-email` | POST | none | none | `authLimiter` + `checkEmailSchema` | Email existence probe — see Security findings (enumeration). |
| `/signup` | POST | none | none | `authLimiter` + `signupSchema` | Creates auth user; domain enforced by DB trigger too. |
| `/me` | GET | `requireAuth` | self | — | Source of truth for role in the SPA. |
| `/me` | PATCH | `requireAuth` | self | `updateProfileSchema` | Zod whitelists updatable fields (no `role`). |

**`/api/tickets`** (`ticketRoutes.js`)

| Route | Method | AuthN | AuthZ | Validation |
|---|---|---|---|---|
| `/` | GET | `optionalAuth` | visibility-scoped | `listTicketsQuerySchema` |
| `/stats` | GET | `optionalAuth` | — | — |
| `/` | POST | `requireAuth` | author=self | `createTicketLimiter` + `createTicketSchema` |
| `/:id` | GET | `optionalAuth` | `getTicketOrThrow` scope | `ticketIdParamSchema` |
| `/:id/timeline` | GET | `optionalAuth` | scope | `ticketIdParamSchema` |
| `/:id` | PATCH | `requireAuth` | owner/staff | `ticketIdParamSchema` + `updateTicketSchema` |
| `/:id/status` | PATCH | `requireAuth` + `requireStaff` | staff + state machine | `updateTicketStatusSchema` |
| `/:id/assign` | PATCH | `requireAuth` + `requireStaff` | staff | `assignTicketSchema` |
| `/:id/flag` | PATCH | `requireAuth` + `requireAdmin` | admin | `flagTicketSchema` |
| `/:id` | DELETE | `requireAuth` | owner/staff (in service) | `ticketIdParamSchema` |
| `/:id/vote` | POST | `requireAuth` | `interactionLimiter` | `ticketIdParamSchema` |
| `/:id/comments` | GET | `optionalAuth` | scope | `ticketIdParamSchema` |
| `/:id/comments` | POST | `requireAuth` | `interactionLimiter` | `createCommentSchema` |
| `/:id/comments/:commentId` | PATCH | `requireAuth` | author (in service) | `updateCommentSchema` |
| `/:id/comments/:commentId` | DELETE | `requireAuth` | author/staff (in service) | — |
| `/:id/rating` | POST | `requireAuth` | reporter only | `interactionLimiter` + `createRatingSchema` |
| `/:id/reopen` | PATCH | `requireAuth` | reporter | `interactionLimiter` + `reopenTicketSchema` |
| `/track/:ticketNumber` | GET | none | public tracking | — |

**`/api/departments`** (`departmentRoutes.js`)

| Route | Method | AuthN | AuthZ | Validation |
|---|---|---|---|---|
| `/` | GET | none | public | — |
| `/` | POST | `requireAuth` + `requireAdmin` | admin | `departmentSchema` |
| `/:id` | PATCH | `requireAuth` + `requireAdmin` | admin | `updateDepartmentSchema` |
| `/:id` | DELETE | `requireAuth` + `requireAdmin` | admin | — |

**`/api/notifications`** (`notificationRoutes.js`)

| Route | Method | AuthN | AuthZ | Validation |
|---|---|---|---|---|
| `/vapid-public-key` | GET | none | public | — |
| `/` | GET | `requireAuth` | self | `listNotificationsQuerySchema` |
| `/read-all` | PATCH | `requireAuth` | self | — |
| `/:id/read` | PATCH | `requireAuth` | self (scoped in service) | — |
| `/subscribe` | POST | `requireAuth` | self | `pushSubscribeSchema` |
| `/subscribe` | DELETE | `requireAuth` | self | `pushUnsubscribeSchema` |

**`/api/announcements`** (`announcementRoutes.js`)

| Route | Method | AuthN | AuthZ | Validation |
|---|---|---|---|---|
| `/` | GET | `optionalAuth` | public/scoped | — |
| `/` | POST | `requireAuth` + `requireStaff` | staff | `announcementSchema` |
| `/:id` | PATCH | `requireAuth` + `requireStaff` | staff | `announcementSchema.partial()` |
| `/:id` | DELETE | `requireAuth` + `requireStaff` | staff | — |
| `/polls` | POST | `requireAuth` + `requireStaff` | staff | `pollSchema` |
| `/polls/:id/vote` | POST | `requireAuth` | any auth | `voteSchema` |
| `/polls/:id/close` | PATCH | `requireAuth` + `requireStaff` | staff | — |

**`/api/admin`** (`adminRoutes.js`)

| Route | Method | AuthN | AuthZ | Validation |
|---|---|---|---|---|
| `/settings` | GET | `requireAuth` + `requireSuperAdmin` | super admin | — |
| `/settings` | PATCH | `requireAuth` + `requireSuperAdmin` | super admin | `settingsSchema` |
| `/maintenance` | GET | none | public | Reads maintenance flag (used pre-login). |
| `/users` | GET | `requireAuth` + `requireAdmin` | admin | — |
| `/users/:id/role` | PATCH | `requireAuth` + `requireAdmin` | admin | `roleSchema` |
| `/users/:id/status` | PATCH | `requireAuth` + `requireAdmin` | admin | `activeSchema` |
| `/analytics` | GET | `requireAuth` + `requireStaff` | staff | — |
| `/moderation` | GET | `requireAuth` + `requireAdmin` | admin | — |
| `/tickets/:id/reveal` | POST | `requireAuth` + `requireAdmin` | admin | `revealSchema` |

### 5.3 Per-endpoint risk observations

- **Consistent guard pattern.** Every mutating endpoint has `requireAuth` plus a role guard where appropriate, and a Zod schema. This is the strongest part of the codebase. `CONFIRMED`.
- **`/api/admin/users/:id/role` (PATCH)** is the sanctioned role-change path and is correctly gated by `requireAdmin`. **However**, note it lets an **Admin** set roles — verify in code whether an Admin can escalate someone (including themselves) to `SUPER_ADMIN`. If `roleSchema` accepts `SUPER_ADMIN`, an Admin could mint a Super Admin. `POSSIBLE` — flagged in `AUDIT 5.md` (P1) pending the enum contents of `roleSchema`.
- **`/api/tickets/:id/reveal`** de-anonymizes an anonymous ticket's author; correctly `requireAdmin`. Good that anonymity is server-enforced (see Workflow in `AUDIT 3.md`).
- **`optionalAuth` on list/detail/stats** means unauthenticated visitors can read public tickets. Visibility is scoped in `getTicketOrThrow`/`ticketService` — this is intended (public complaint board). `CONFIRMED`.
- **`/api/auth/check-email`** enables account enumeration despite the rate limiter. `CONFIRMED` route exists; severity Medium (see Security).
- **Errors** flow through a single `errorHandler` that returns generic messages and hides stack traces when `NODE_ENV=production`. `CONFIRMED`.
- **Request body size** is limited globally by `express.json({ limit })`. `CONFIRMED`.
- **Rate limiting** exists per-area (`authLimiter`, `createTicketLimiter`, `interactionLimiter`, global `apiLimiter`) but uses the **in-memory** store, so it is per-instance and resets on restart/cold start. `CONFIRMED`.

### 5.4 Services layer

- **`ticketService.js`** centralizes ticket reads/writes, ownership checks (`getTicketOrThrow`), the **status state machine**, ticket-number generation, and serialization (including anonymity redaction). This keeps authorization logic server-side and DRY. `CONFIRMED`.
- **`pushService.js`** wraps `web-push`; **degrades to a no-op if VAPID keys are absent** (so the app doesn't crash without push configured). `CONFIRMED`.
- **`settingsService.js`** caches `app_settings` in memory (maintenance mode, feature flags). **In-memory cache is per-instance** — a concern for multi-instance/Functions consistency. `CONFIRMED`.
- **`domainPolicy`** encodes the allowed signup email domain(s), mirrored by a DB trigger.

### 5.5 Suitability for Vercel Functions (backend-side notes)

- Handlers are mostly stateless and `async` → portable.
- **Not clean for Functions:** the in-memory settings cache, the in-memory rate-limit store, and the **synchronous broadcast fan-out** in the announcements path (long-running). Detailed classification in `AUDIT 4.md` §Vercel.

---

## 6. Authentication Audit

`CONFIRMED` unless noted. Sources: `frontend/src/context/AuthContext.jsx`, `frontend/src/lib/supabase.js`, `backend/src/middleware/auth.js`, `backend/src/routes/authRoutes.js`, `backend/prisma/sql/01_post_migration.sql`.

### 6.1 Signup flow

1. Browser calls Supabase Auth to create the user (email/password), gated by `POST /api/auth/signup` (`authLimiter` + `signupSchema`) and/or `supabase.auth.signUp`.
2. **DB trigger `on_auth_user_created` → `handle_new_user()`** inserts a matching row into `public.profiles` (id, email, full_name, matric_number, faculty, timestamps). `CONFIRMED` (`01_post_migration.sql` lines 118–141).
3. **DB trigger `on_auth_user_check_domain` → `enforce_signup_email_domain()`** rejects signups whose email is outside the allowed ABUAD domain(s). `CONFIRMED` (lines 154–204). This is enforced **server-side in the database**, so it can't be bypassed by calling Supabase directly — a genuinely strong control.

### 6.2 Login / session

- `signInWithPassword` in `AuthContext`. Supabase persists the session (localStorage) and auto-refreshes tokens; `onAuthStateChange` keeps React state in sync. `CONFIRMED`.
- The SPA never trusts the JWT's role claim for authorization decisions — it calls `GET /api/auth/me`. `CONFIRMED`.

### 6.3 Backend token verification (the real gate)

- `requireAuth` extracts the `Bearer` token and calls `supabaseAdmin.auth.getUser(token)` to verify it against Supabase, then loads the profile and attaches `{ id, role, is_active, ... }` to `req.user`. `CONFIRMED` in `middleware/auth.js`.
- **Disabled users:** the middleware checks `is_active`; the `is_staff()` / `is_super_admin()` DB functions also require `is_active = true`. So deactivating a user blocks both API and RLS-privileged paths. `CONFIRMED`.
- `optionalAuth` verifies a token if present but allows anonymous through (public reads).

### 6.4 Password reset / email verification

- `resetPasswordForEmail` and `updateUser({ password })` are wired in `AuthContext`; dedicated `ForgotPassword` / `ResetPassword` pages exist. `CONFIRMED` (handled by Supabase Auth).
- Email verification behavior is delegated to Supabase project settings. `UNABLE TO VERIFY` the exact "confirm email" toggle from the repo (it's a Supabase dashboard setting, not in code).

### 6.5 OAuth / Google

- **None found.** No `signInWithOAuth`/Google provider usage in the repo. `CONFIRMED` (email/password only).

### 6.6 Authentication weaknesses

- **Account enumeration** via `POST /api/auth/check-email` (and, generally, Supabase auth error differences). `CONFIRMED` route; Medium.
- **Session lives in localStorage** (Supabase default), which is readable by any XSS. Mitigated by no known XSS sink found, but see CSP gap (`AUDIT 5.md`). `LIKELY`.
- **No server-side session revocation list** beyond `is_active` — a stolen JWT is valid until it expires/refresh is revoked. Standard for Supabase; acceptable. `RECOMMENDATION`: keep token TTL modest.
- **Direct Supabase access** means auth is only as strong as RLS for anything reachable via PostgREST (see §7). This is where the P0 lives.

---

## 7. Authorization / RBAC Audit

### 7.1 Roles

`CONFIRMED` — roles are stored as `profiles.role` with values used in code/SQL:

- `STUDENT` (default)
- `REP` (SRC Member)
- `ADMIN`
- `SUPER_ADMIN`

Guards (`backend/src/middleware/auth.js`): `requireAuth`, `requireStaff` (REP or ADMIN — and SUPER_ADMIN by extension where implemented), `requireAdmin`, `requireSuperAdmin`. DB mirrors: `is_staff()` = role in (`REP`,`ADMIN`) AND active; `is_super_admin()` = role `SUPER_ADMIN` AND active. `CONFIRMED`.

> Note: `is_staff()` in SQL checks `role in ('REP','ADMIN')` and does **not** list `SUPER_ADMIN`. Verify whether Super Admin is expected to pass staff-only RLS reads; if a Super Admin has `role='SUPER_ADMIN'`, `is_staff()` returns false for them. `POSSIBLE` inconsistency — flagged P2 in `AUDIT 5.md`.

### 7.2 Permission matrix (from actual implementation)

Legend: ✅ allowed · ❌ denied · ⚠️ allowed but see note.

| Capability | Student | SRC (REP) | Admin | Super Admin |
|---|:--:|:--:|:--:|:--:|
| Create complaint (`POST /tickets`) | ✅ | ✅ | ✅ | ✅ |
| View own complaint | ✅ | ✅ | ✅ | ✅ |
| View others' **public** complaints | ✅ | ✅ | ✅ | ✅ |
| View others' **private** complaints | ❌ | ✅ (staff) | ✅ | ✅ |
| Comment | ✅ | ✅ | ✅ | ✅ |
| Vote / rate own-eligibility | ✅ | ✅ | ✅ | ✅ |
| Respond as staff / change status (`/status`) | ❌ | ✅ | ✅ | ✅ |
| Assign ticket (`/assign`) | ❌ | ✅ | ✅ | ✅ |
| Flag/moderate ticket (`/flag`, `/moderation`) | ❌ | ❌ | ✅ | ✅ |
| Reveal anonymous author (`/reveal`) | ❌ | ❌ | ✅ | ✅ |
| Delete complaint | own | own/staff | ✅ | ✅ |
| Manage users list (`/admin/users`) | ❌ | ❌ | ✅ | ✅ |
| Change user roles (`/users/:id/role`) | ❌ | ❌ | ⚠️ | ✅ |
| Enable/disable users (`/users/:id/status`) | ❌ | ❌ | ✅ | ✅ |
| Access analytics (`/admin/analytics`) | ❌ | ✅ | ✅ | ✅ |
| Manage departments | ❌ | ❌ | ✅ | ✅ |
| Manage announcements/polls | ❌ | ✅ | ✅ | ✅ |
| System settings (`/admin/settings`) | ❌ | ❌ | ❌ | ✅ |

⚠️ **Role management by Admin:** confirm whether `roleSchema` permits assigning `SUPER_ADMIN`. If yes → an Admin can create a Super Admin (privilege escalation within the sanctioned API). `POSSIBLE`; P1 in `AUDIT 5.md`.

### 7.3 Conceptual abuse tests (via the API)

- **Lower-priv user calling admin APIs directly:** blocked by `requireAdmin`/`requireSuperAdmin` on the server. `CONFIRMED` safe.
- **IDOR on `/tickets/:id`:** `getTicketOrThrow` enforces visibility (public OR owner OR staff) before returning. A student passing another student's private ticket ID gets 403/404. `CONFIRMED` safe at the API layer.
- **Mass assignment via API:** Zod schemas whitelist fields; `PATCH /auth/me` and `PATCH /tickets/:id` cannot set `role`, `author_id`, or status out-of-band. `CONFIRMED` safe at the API layer.
- **The real gap is NOT the API — it's direct PostgREST.** See §8.

---

## 8. Supabase Database Audit

Sources: `backend/prisma/schema.prisma`, `backend/prisma/sql/01..05`.

### 8.1 Table overview

| Table | Purpose | Key columns | FKs | RLS enabled | Sensitive |
|---|---|---|---|:--:|---|
| `profiles` | User identity + role | `id`(=auth.users.id), `email`, `full_name`, `matric_number`, `faculty`, `role`, `is_active`, `department_id` | `id→auth.users`, `department_id→departments` | ✅ | **role**, matric, email |
| `departments` | SRC categories | `id`, `name`, `slug`, `category`, `is_active` | — | ✅ | no |
| `tickets` | Complaints | `id`, `ticket_number`, `author_id`, `department_id`, `title`, `body`, `status`, `is_public`, `is_anonymous`, `is_flagged`, `upvote_count`, `comment_count` | `author_id→profiles`, `department_id→departments` | ✅ | body may be sensitive |
| `ticket_attachments` | Image refs | `id`, `ticket_id`, `storage_path`, `mime`, `size` | `ticket_id→tickets` | ✅ | image content |
| `ticket_comments` | Replies | `id`, `ticket_id`, `author_id`, `body` | FKs to tickets/profiles | ✅ | possibly |
| `ticket_events` | Timeline/audit of ticket changes | `id`, `ticket_id`, `type`, `actor_id`, `meta` | FKs | ✅ | — |
| `ticket_votes` | Upvotes | `ticket_id`, `user_id` (unique pair) | FKs | ✅ | — |
| `ticket_ratings` | Post-resolution rating | `ticket_id`(unique), `user_id`, `score` (CHECK 1..5) | FKs | ✅ | — |
| `notifications` | In-app notifications | `id`, `user_id`, `type`, `payload`, `read_at` | `user_id→profiles` | ✅ | — |
| `push_subscriptions` | Web Push endpoints | `id`, `user_id`, `endpoint`, `keys` | `user_id→profiles` | ✅ | push secrets |
| `announcements` | Staff broadcasts | `id`, `author_id`, `title`, `body`, `audience` | FKs | ✅ | — |
| `polls`/`poll_options`/`poll_votes` | Polls | ids, counts, `user_id` | FKs | ✅ | — |
| `saved_views` | Saved filters | `id`, `user_id`, `query` | FK | ✅ | — |
| `app_settings` | System settings/maintenance | key/value | — | ✅ | — |
| `audit_logs` | Intended audit trail | actor, action, target, meta | — | ✅ | — |

### 8.2 Triggers & DB functions

`CONFIRMED` (`01_post_migration.sql`, `04_phase4.sql`):

- `next_ticket_number()` — generates human ticket numbers.
- `handle_new_user()` + trigger `on_auth_user_created` — creates `profiles` row on signup.
- `enforce_signup_email_domain()` + trigger `on_auth_user_check_domain` — enforces ABUAD email domain at the DB.
- `sync_ticket_upvote_count()` / `trg_ticket_votes_count` — denormalized upvote counter.
- `sync_ticket_comment_count()` / `trg_ticket_comments_count` — denormalized comment counter.
- `sync_poll_option_vote_count()` (01) and `sync_poll_option_votes()` + `poll_votes_sync` (04) — poll vote counters.
- `is_staff()` (01, redefined in 04) and `is_super_admin()` (04) — `security definer` helpers used by RLS.
- Rating range enforced via CHECK constraint `ticket_ratings_score_range` (1..5) — Prisma can't express it, so added in SQL. `CONFIRMED`.

### 8.3 Observations

- **Denormalized counters via triggers** are efficient for reads (no `count()` on hot paths for votes/comments). Good.
- **`audit_logs` table exists but no route writes to it** was found in the route inventory. `LIKELY` unused/aspirational — flagged in Observability (`AUDIT 5.md`).
- **Prisma + hand-written SQL split:** schema managed by Prisma, but RLS/triggers/policies live in `prisma/sql/*.sql` applied manually in Supabase. This is a **deployment risk** — nothing guarantees the SQL files were run, or run in order, on prod. `RECOMMENDATION` (see `AUDIT 5.md` §Deployment).

---

## 9. Row Level Security (RLS) Audit

**All 17 listed tables have RLS enabled** (`01_post_migration.sql` lines 287–303). `CONFIRMED`. The critical question is whether the **policies** are tight, because the browser can call PostgREST directly with the anon key + user JWT.

### 9.1 Policy-by-policy

**`profiles`**
- `profiles_select_own` — `SELECT using (id = auth.uid() or public.is_staff())`. A user reads their own profile; staff read all. `CONFIRMED` reasonable.
- `profiles_update_own` — `UPDATE using (id = auth.uid()) with check (id = auth.uid())`. **This is the P0.** It restricts *which row* you can update (your own) but **does not restrict which columns**. Postgres RLS cannot restrict columns by itself; there is **no `BEFORE UPDATE` trigger and no column privilege (`GRANT`/`REVOKE`) protecting `role`** found in the SQL. Therefore an authenticated student can run, directly against PostgREST:
  ```js
  supabase.from('profiles').update({ role: 'SUPER_ADMIN' }).eq('id', myId)
  ```
  and RLS will permit it (row is their own, `with check` passes). **This grants full Super Admin.** `CONFIRMED` policy text; `LIKELY` exploitable (assuming PostgREST is exposed with the anon key, which the frontend's use of `supabase-js` implies). See `AUDIT 5.md` **P0-1** for remediation options (column GRANT/REVOKE, a role-change trigger, or a restrictive `with check` referencing `OLD.role`).

**`tickets`**
- `tickets_select` — `SELECT using ((is_public = true and is_flagged = false) or author_id = auth.uid() or public.is_staff())`. Correctly prevents cross-student reads of private/flagged tickets; staff see all. `CONFIRMED`. Note the comment explicitly says **anonymity is enforced by the API serializer, not RLS** — so if a client reads `tickets` directly via PostgREST, it can see `author_id` even for anonymous public tickets. `POSSIBLE` anonymity leak via direct PostgREST — flagged P1 in `AUDIT 5.md`.
- Write policies for tickets: verify presence of tight `INSERT/UPDATE/DELETE` policies. The 04 migration notes "existing policies granted SELECT but never constrained writes" for some tables and adds `for all` policies (e.g. `app_settings` restricted to `is_super_admin()`). **Confirm each writable table has a `with check` that pins `author_id = auth.uid()` on INSERT** and owner/staff on UPDATE/DELETE. `POSSIBLE` gap — see P1.

**`notifications`** — `notifications_select_own` and `notifications_update_own` scope to `user_id = auth.uid()`. `CONFIRMED` good (a user can't read others' notifications).

**`ticket_votes`** — `ticket_votes_select` (readable) + `ticket_votes_write_own` (write scoped to own `user_id`). `CONFIRMED`.

**`ticket_comments`** — `ticket_comments_select` present; verify write policy pins `author_id = auth.uid()`. `POSSIBLE`.

**`ticket_ratings`** — `ticket_ratings_own` `for all using (user_id = auth.uid() or is_staff()) with check (user_id = auth.uid())`. `CONFIRMED` good.

**`push_subscriptions`** — `push_subscriptions_own` scoped to owner. `CONFIRMED`.

**`saved_views`** — `saved_views_own` scoped to owner. `CONFIRMED`.

**`announcements`** — `announcements_select` (broad read). Writes go through the API (`requireStaff`). Confirm no permissive direct-write policy. `POSSIBLE`.

**`polls` / `poll_options`** — `..._select using (true)` (public read). `poll_votes_own` scopes votes to the owner. `CONFIRMED` for votes.

**`departments`** — `departments_select using (true)` (public read). Writes via API admin only. `CONFIRMED` read.

**`app_settings`** — 04 migration adds `for all using (is_super_admin()) with check (is_super_admin())`. `CONFIRMED` good — settings locked to Super Admin even via PostgREST.

### 9.2 Conceptual RLS tests

| Test | Result | Basis |
|---|---|---|
| Student A reads Student B's **public** ticket | ✅ allowed (by design) | `tickets_select` |
| Student A reads Student B's **private** ticket | ❌ blocked | `tickets_select` (author/staff/public only) |
| Student A modifies Student B's ticket | ❌ blocked *if* write policy pins author | needs confirm (`POSSIBLE`) |
| Student A deletes Student B's ticket | ❌ blocked *if* delete policy pins author/staff | needs confirm |
| **Student A changes their own `role`** | ⚠️ **ALLOWED via PostgREST** | `profiles_update_own` has no column guard → **P0** |
| Student A inserts a ticket as Student B (`author_id=B`) | ❌ blocked *if* insert `with check (author_id = auth.uid())` | needs confirm (`POSSIBLE`) |
| SRC/Admin over-reach beyond role | ❌ blocked by role guards + `is_super_admin()` | `CONFIRMED` for settings |
| Read another user's notifications | ❌ blocked | `notifications_select_own` |
| De-anonymize via direct `tickets` read | ⚠️ POSSIBLE | anonymity is API-serializer only |

**Bottom line:** RLS is *mostly* well-designed and clearly iterated on (04 explicitly tightened writes). The **`profiles.role` column exposure is a genuine P0**, and a small number of write policies need a direct `with check` confirmation to rule out cross-user writes and `author_id` spoofing through PostgREST.

*Continued in `AUDIT 3.md` — Complaint Workflow, Storage, Notifications, PWA, and API Security.*
