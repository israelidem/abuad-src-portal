# ABUAD SRC Portal — Technical Audit (Part 5 of 6)

> **Scope of this file:** Security Findings (with severities) · Security Headers · Rate Limiting & Abuse · Data Validation · Secrets & Configuration · Error Handling · Observability · Reliability · Accessibility · SEO / PWA / Web Quality
> **Prev:** `AUDIT 4.md` · **Next:** `AUDIT 6.md` (Testing, Deployment, Architecture Recommendation, Prioritized Remediation, Open Questions, Production-Readiness Score)

---

## 22. Security Findings

Each finding: **Severity · Finding · Location · Attack scenario · Impact · Evidence · Remediation**. Labels: `CONFIRMED` / `LIKELY` / `POSSIBLE` / `UNABLE TO VERIFY`.

### CRITICAL

#### P0-1 — `profiles.role` is writable by the row owner via RLS (privilege escalation)
- **Severity:** Critical (P0)
- **Finding:** The `profiles_update_own` policy authorizes updates by row (`id = auth.uid()`) but does not restrict **which columns** may change, and no `BEFORE UPDATE` trigger or column `REVOKE` protects `role`.
- **Location:** `backend/prisma/sql/01_post_migration.sql` lines 324–326:
  ```sql
  create policy profiles_update_own on public.profiles
    for update using (id = auth.uid()) with check (id = auth.uid());
  ```
- **Attack scenario:** An authenticated student, using the Supabase anon key + their own JWT (both present in the shipped frontend), calls PostgREST directly, bypassing Express entirely:
  ```js
  await supabase.from('profiles').update({ role: 'SUPER_ADMIN' }).eq('id', myUserId)
  ```
  RLS passes (row is theirs, `with check` satisfied). They are now Super Admin; `is_super_admin()` returns true; every admin/super-admin API and every RLS-privileged action opens up.
- **Impact:** Full privilege escalation → complete compromise of RBAC, user management, settings, de-anonymization of complaints.
- **Evidence:** `CONFIRMED` policy text; `LIKELY` exploitable (frontend uses `supabase-js`, implying PostgREST/anon key are reachable). The role-change API path (`/api/admin/users/:id/role`) is correctly guarded, but the **database path is not**.
- **Remediation (do NOT implement now):** Any one (ideally layered): (a) `REVOKE UPDATE (role, is_active) ON public.profiles FROM authenticated;` and only allow those columns via service-role/RPC; (b) a `BEFORE UPDATE` trigger that raises if `NEW.role <> OLD.role` unless `is_super_admin()`; (c) split into a restrictive column-scoped policy. Re-test by attempting the direct update as a student.

### HIGH

#### P1-1 — Direct-to-PostgREST write surface not fully constrained (cross-user writes / `author_id` spoofing)
- **Severity:** High (P1)
- **Finding:** Several tables have confirmed `SELECT`/owner policies, but for a few writable tables (e.g. `tickets`, `ticket_comments`, `announcements`) the audit could not confirm a tight `with check` pinning `author_id = auth.uid()` on INSERT and owner/staff on UPDATE/DELETE. The 04 migration explicitly notes some tables "granted SELECT but never constrained writes."
- **Location:** `01_post_migration.sql` (policies section), `04_phase4.sql`.
- **Attack scenario:** Student inserts a ticket/comment with `author_id` set to another user (impersonation), or updates/deletes another user's row, via direct PostgREST — if the write `with check` is missing/loose.
- **Impact:** Impersonation, tampering, content forgery attributed to others.
- **Evidence:** `POSSIBLE` — needs confirmation of each write policy's `with check`. (API paths are safe because the server sets `author_id`.)
- **Remediation:** Verify/add `with check (author_id = auth.uid())` on INSERT and owner/staff predicates on UPDATE/DELETE for every user-writable table.

#### P1-2 — Anonymity not enforced at the database layer
- **Severity:** High (P1) — privacy
- **Finding:** Anonymous-complaint `author_id` is redacted only by the **API serializer**; `tickets_select` still returns the row (incl. `author_id`) to any client that reads `tickets` directly via PostgREST for public, non-flagged tickets.
- **Location:** `01_post_migration.sql` lines 331–337 (comment explicitly says anonymity is API-enforced); `ticketService` serializer.
- **Attack scenario:** A student reads the public board directly through `supabase.from('tickets').select('*')` and sees the real `author_id` of "anonymous" complaints, then joins to `profiles` (subject to profile RLS) or correlates.
- **Impact:** De-anonymization of complainants — serious for a grievance system.
- **Evidence:** `POSSIBLE`/`LIKELY` depending on whether the frontend path is the only reader; the capability exists.
- **Remediation:** Don't expose `author_id` on anonymous rows via RLS (e.g., a view that omits it, or column-level protection), or route all ticket reads through the API and restrict direct `tickets` SELECT.

#### P1-3 — Public storage bucket exposes complaint evidence
- **Severity:** High (P1) — privacy
- **Finding:** `ticket-attachments` bucket is `public = true`; `ticket_attachments_read_public` grants SELECT to `public`.
- **Location:** `backend/prisma/sql/02_storage.sql` lines 21–32, 69–71.
- **Attack scenario:** Anyone with (or able to guess) an object URL reads complaint photos without authentication. UUID paths make guessing hard, but URLs leak via referrers, shared links, caches, and the public board markup.
- **Impact:** Confidential complaint imagery readable by unauthenticated third parties.
- **Evidence:** `CONFIRMED` bucket config.
- **Remediation:** Make the bucket private; serve via short-lived signed URLs generated server-side for authorized viewers.

#### P1-4 — Possible Admin→Super Admin escalation via sanctioned role API
- **Severity:** High (P1) if confirmed
- **Finding:** `PATCH /api/admin/users/:id/role` is `requireAdmin` (not `requireSuperAdmin`). If `roleSchema` accepts `SUPER_ADMIN`, an Admin can promote anyone (incl. self) to Super Admin.
- **Location:** `backend/src/routes/adminRoutes.js`, `backend/src/validators/*` (`roleSchema`).
- **Attack scenario:** A merely-Admin account elevates itself to Super Admin, gaining settings and full control.
- **Impact:** Vertical privilege escalation within the app.
- **Evidence:** `POSSIBLE` — depends on `roleSchema` enum contents (not fully quoted in this pass).
- **Remediation:** Restrict assigning/あremoving `SUPER_ADMIN` to `requireSuperAdmin`; forbid self-role-change.

### MEDIUM

#### P2-1 — No security headers on the frontend (Vercel)
- **Severity:** Medium
- **Finding:** `frontend/vercel.json` sets caching headers only. No CSP, HSTS, X-Frame-Options/`frame-ancestors`, Referrer-Policy, Permissions-Policy on the HTML app.
- **Location:** `frontend/vercel.json`.
- **Impact:** Larger XSS blast radius (session token is in localStorage), clickjacking exposure, referrer leakage.
- **Evidence:** `CONFIRMED`.
- **Remediation:** Add a `headers` block: CSP (script/style/connect/img/frame-ancestors), HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`.

#### P2-2 — Account enumeration via `/api/auth/check-email`
- **Severity:** Medium
- **Finding:** An endpoint that reports whether an email exists; rate-limited but still an oracle.
- **Location:** `backend/src/routes/authRoutes.js` (`POST /check-email`).
- **Impact:** Enables targeted phishing/credential-stuffing lists scoped to real ABUAD accounts.
- **Evidence:** `CONFIRMED` route exists.
- **Remediation:** Return a generic response; rely on signup/login flows to handle existence server-side without disclosing it.

#### P2-3 — Session token in localStorage + shared-device persistence
- **Severity:** Medium
- **Finding:** Supabase default localStorage session persists across users on shared machines; combined with no CSP, XSS could exfiltrate it.
- **Location:** `frontend/src/lib/supabase.js` (client config), `AuthContext`.
- **Impact:** Session theft on XSS; lingering sessions on shared/lab PCs.
- **Evidence:** `LIKELY`.
- **Remediation:** Prominent logout, idle timeout, and CSP (P2-1). Consider shorter token TTLs.

#### P2-4 — `is_staff()` excludes `SUPER_ADMIN`
- **Severity:** Medium (correctness/authorization consistency)
- **Finding:** `is_staff()` checks `role in ('REP','ADMIN')`; a `SUPER_ADMIN` fails staff-only RLS reads.
- **Location:** `01_post_migration.sql` line 315 / `04_phase4.sql` line 31.
- **Impact:** Super Admins may be unexpectedly denied staff-scoped direct reads (or logic elsewhere compensates inconsistently).
- **Evidence:** `POSSIBLE` inconsistency.
- **Remediation:** Include `SUPER_ADMIN` in `is_staff()` (or `is_staff() OR is_super_admin()` at call sites).

#### P2-5 — Manual, unversioned application of RLS/trigger SQL
- **Severity:** Medium (deployment/security drift)
- **Finding:** Security-critical DDL (RLS, triggers, storage policies) lives in `prisma/sql/*.sql` applied by hand in the Supabase SQL editor; nothing enforces that all files ran, in order, on prod.
- **Location:** `backend/prisma/sql/01..05`, `README/PROD/SETUP`.
- **Impact:** A missed file = missing RLS/triggers = silent security hole (this is exactly how P0-style gaps persist).
- **Evidence:** `LIKELY` (Prisma migrations don't manage this SQL).
- **Remediation:** Fold policies/triggers into versioned migrations or a checked idempotent bootstrap run in CI/deploy; add a verification query.

### LOW

- **P3-1** No API client timeout/retry (`lib/api.js`) — reliability/DoS-resilience. `CONFIRMED`.
- **P3-2** MIME allowlist drift across client/bucket/backend (`AUDIT 3.md` §11.3). `POSSIBLE`.
- **P3-3** supabase-js version drift front/back. `CONFIRMED`.
- **P3-4** In-memory rate-limit + settings cache won't hold across instances/Functions. `CONFIRMED`.
- **P3-5** No global error boundary in the SPA (`AUDIT 1.md` §4.7). `CONFIRMED`.
- **P3-6** `audit_logs` table present but no writes wired → no audit trail. `LIKELY`.

---

## 23. Security Headers (detail)

| Header | API (Express/helmet) | Frontend (Vercel) |
|---|---|---|
| X-Content-Type-Options | ✅ (helmet) | ❌ |
| X-Frame-Options / frame-ancestors | ✅ (helmet default) | ❌ |
| Referrer-Policy | ✅ (helmet) | ❌ |
| Strict-Transport-Security | ✅ (helmet, if HTTPS) | ❌ (relies on Vercel default) |
| Content-Security-Policy | ⚠️ helmet default (verify enabled) | ❌ |
| Permissions-Policy | ⚠️ | ❌ |
| CORS | ✅ allowlist (not `*`) | n/a |
| Cookies | n/a (JWT in localStorage, not cookies) | n/a |

`CONFIRMED`. The **frontend HTML host is where these matter most** and it currently ships none (P2-1).

---

## 24. Rate Limiting & Abuse

| Action | Protected? | Mechanism | Notes |
|---|---|---|---|
| Login / signup / check-email | ✅ | `authLimiter` (server, in-memory) | Good, but enumeration remains (P2-2) |
| Complaint creation | ✅ | `createTicketLimiter` | Anti-spam |
| Comments / votes / ratings / reopen | ✅ | `interactionLimiter` | Anti-abuse |
| Notifications read/subscribe | ✅ (global) | `apiLimiter` | — |
| Admin endpoints | ✅ (global) + role guards | `apiLimiter` | — |
| Search / list | ✅ (global) | `apiLimiter` | — |
| **Direct Supabase PostgREST/Storage** | ❌ | none (Supabase limits only) | Bypasses all app limiters — RLS is the only guard |

- **Server-side, not client-side** — meaningful protection. `CONFIRMED`.
- **In-memory store** → per-instance; fragments on scale-out/Functions and resets on cold start. `CONFIRMED`. Use a shared store if scaling.

---

## 25. Data Validation

- **Library:** **Zod**, applied via `validateBody/validateQuery/validateParams` (`middleware/validate.js`) across `authSchemas`, `ticketSchemas`, `notificationSchemas`. `CONFIRMED`.
- **Coverage:** effectively all mutating endpoints (see route tables in `AUDIT 2.md`).
- **Protects against:** mass assignment (unknown keys rejected), type confusion, arrays-where-strings, oversized strings where `.max()` set, out-of-range values (ratings CHECK also at DB).
- **Gaps to verify:** ensure every string field has a `.max()`; ensure the attachment MIME set matches the bucket (P3-2); ensure query params (page/limit) are bounded to prevent huge `limit`. `POSSIBLE`.
- **SQL injection:** Prisma parameterizes; no raw concatenated SQL in request paths. `CONFIRMED` low risk.
- **Prototype pollution:** no `Object.assign(req.body)`/merge patterns; Zod-parsed objects used. `LIKELY` safe.

---

## 26. Secrets & Configuration

Sources: `backend/.env.example`, `backend/.env` (values **not** printed), `frontend/.env`, `backend/src/config/env.js`, `render.yaml`, `frontend/vercel.json`. **No secret values are reproduced here.**

| Variable | Tier | Exposure class | Status |
|---|---|---|---|
| `VITE_API_URL` | frontend | safe (public) | referenced |
| `VITE_SUPABASE_URL` | frontend | safe (public) | referenced |
| `VITE_SUPABASE_ANON_KEY` | frontend | public by design (RLS-gated) | referenced |
| `VITE_VAPID_PUBLIC_KEY` | frontend | public by design | referenced |
| `DATABASE_URL` (pooled, 6543, pgbouncer) | backend | **secret** | referenced |
| `DIRECT_URL` (5432, migrations) | backend | **secret** | referenced |
| `SUPABASE_URL` | backend | low-sensitivity | referenced |
| `SUPABASE_SERVICE_ROLE_KEY` | backend | **highly sensitive** (bypasses RLS) | referenced |
| `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY` / `VAPID_SUBJECT` | backend | private key = **secret** | referenced |
| `CLIENT_URL` / `CORS_ORIGINS` | backend | config | referenced |
| `NODE_ENV`, `PORT` | backend | config | referenced |

Observations:
- **Correct split:** only `VITE_*` (public-safe) are in the frontend; the **service-role key and DB URLs are backend-only**. `CONFIRMED`. No service-role key found referenced in `frontend/`. `CONFIRMED` (good — this is the classic mistake and it was avoided).
- **`render.yaml` uses `sync: false`** for secrets (set in dashboard, not committed). `CONFIRMED` good.
- **Anon key in the browser is expected** and safe *only if RLS is correct* — which circles back to P0-1/P1-1. `CONFIRMED`.
- **`.env` files:** ensure they're git-ignored (`.gitignore` present). `RECOMMENDATION`: confirm no `.env` with real secrets is tracked in history.

---

## 27. Error Handling

- **Central handler** `middleware/errorHandler.js`: normalizes errors, returns generic JSON, and **hides stack traces when `NODE_ENV=production`**. `CONFIRMED`.
- **`asyncHandler`** wraps route handlers so rejected promises reach the error handler (no unhandled rejections leaking). `CONFIRMED`.
- **`/health`** returns 503 when Postgres is unreachable (used by keep-alive + Render health check). `CONFIRMED`.
- **Leakage check:** no evidence of SQL text, stack traces, API keys, or internal paths returned to clients in production mode. `LIKELY` safe. Verify Prisma error codes aren't passed through verbatim on unique-constraint violations (could reveal field names). `POSSIBLE` minor.
- **Frontend:** per-page error states exist; **no global error boundary** (P3-5). Fetch errors during Render cold start have **no timeout** (P3-1), so the UI can appear to hang rather than show an error.

---

## 28. Observability

| Capability | Present? | Evidence |
|---|---|---|
| Structured logging (JSON, levels) | ❌ (console logging) | no logger dep (pino/winston) found |
| Request IDs / correlation | ❌ | none found |
| Error tracking (Sentry, etc.) | ❌ | no SDK in deps |
| Performance monitoring / APM | ❌ | none |
| Audit logs (who did what) | ⚠️ table exists, unused | `audit_logs` present; no writes wired |
| Admin action logging | ❌ | role/status changes not persisted to an audit trail |
| DB monitoring | ⚠️ external only | Supabase dashboard |
| Uptime monitoring | ⚠️ partial | GH keep-alive pings `/health` but isn't alerting |

`CONFIRMED` gaps. For a system handling grievances and admin actions, the **missing audit trail** (P3-6) and **no error tracking** are the most consequential — you cannot currently answer "who changed this ticket's status / this user's role, and when" from application logs. `RECOMMENDATION`: wire `audit_logs` on privileged mutations; add Sentry (or similar) + a structured logger; add request IDs.

---

## 29. Reliability

| Scenario | Current behaviour | Assessment |
|---|---|---|
| Supabase briefly unavailable | `/health` → 503; API calls error out; no retry/circuit-breaker | `LIKELY` user-visible failures; acceptable if transient |
| Render waking (cold start) | First request blocks ~30–60s; **no client timeout** | P3-1 — feels broken; add timeout + "waking" UI |
| Vercel static failure | Rare; static hosting | Low risk |
| DB query timeout | Surfaces as 500 via error handler | No per-query timeout configured (`POSSIBLE`) |
| Notification delivery fails | `pushService` handles send errors; **verify pruning on 404/410** | `POSSIBLE` dead-subscription buildup |
| Image upload fails | Client surfaces error; **orphan risk** if ticket insert then fails | P1-3-adjacent lifecycle gap |
| Notification permission denied | App still works; in-app notifications remain | Graceful `CONFIRMED` |
| User loses connectivity | SW serves shell; data pages may blank (no boundary) | `POSSIBLE` |
| **User double-clicks submit** | **No idempotency** → duplicate tickets possible | `LIKELY` (mitigated only by rate limit) |
| Request retried | No idempotency keys | Duplicates `POSSIBLE` |
| **Two admins edit same ticket** | **No optimistic locking** → last-write-wins | `LIKELY` race |

- **Transactions:** `ticketService` uses Prisma transactions where multi-row consistency matters (e.g., ticket + attachments/events). `CONFIRMED` in part; verify all multi-write paths are wrapped. `POSSIBLE`.
- **Rollback:** DB transactions roll back on error; **cross-system** ops (Storage upload + DB insert) are **not** atomic → orphan risk. `CONFIRMED` conceptually.
- `RECOMMENDATION`: idempotency keys on `POST /tickets`; optimistic concurrency (`version`/`updated_at`) on staff mutations; prune dead push subscriptions; per-query timeouts.

---

## 30. Accessibility (static review)

Sources: components/pages (buttons, inputs, `AttachmentPicker`, modals, `NotificationBell`, `ThemeToggle`).

- **Semantic HTML & labels:** `AttachmentPicker` uses a real `<input type="file">` with `accept`, `aria-hidden` on decorative icons, and visible instructional text. `CONFIRMED` reasonable in the components sampled.
- **Icon-only buttons:** several use `lucide-react` icons; verify each has `aria-label`/visible text (e.g., remove-attachment `X`, bell, theme toggle). `POSSIBLE` gaps.
- **Keyboard nav & focus:** React Router SPA; verify focus management on route change and modal open/close (focus trap). No focus-trap library found. `POSSIBLE` gaps for modals/dialogs.
- **Forms/errors:** inline error text present (e.g., attachment limit). Verify errors are associated via `aria-describedby` and announced (`role="alert"`). `POSSIBLE`.
- **Color contrast:** Tailwind slate palette with dark mode; contrast not measured. `UNABLE TO VERIFY` without tooling.
- **Touch targets:** mobile-first sizing appears adequate (padded buttons). `LIKELY` OK; not measured.
- **Do not claim compliance:** No automated (axe) or manual AT testing performed. `RECOMMENDATION`: run axe + keyboard-only + screen-reader passes, focusing on modals and icon buttons.

---

## 31. SEO / PWA / Web Quality

Sources: `frontend/index.html`, `manifest.webmanifest`, `vercel.json`, icon scripts.

- **Title & meta description:** present in `index.html`. `CONFIRMED`.
- **Open Graph tags:** present. `CONFIRMED`.
- **theme-color / viewport:** present. `CONFIRMED`.
- **Manifest & icons:** `manifest.webmanifest` linked; icons generated (multiple sizes). Installable. `CONFIRMED`.
- **Favicon:** present. `CONFIRMED`.
- **robots / canonical:** `UNABLE TO VERIFY` a `robots.txt`/canonical setup from the files reviewed. For an authenticated portal, SEO is low priority, but a `robots.txt` disallowing indexing of app routes is advisable. `RECOMMENDATION`.
- **SPA routing on Vercel:** rewrite to `index.html` for client routing. `CONFIRMED`.
- **Mobile responsiveness:** Tailwind, mobile-first components. `LIKELY` good; not device-tested.
- **PWA quality:** SW caches shell/assets, bypasses API — good hygiene (see `AUDIT 3.md` §13). Lighthouse not run — `UNABLE TO VERIFY` exact scores.

*Continued in `AUDIT 6.md` — Testing, Deployment/CI-CD, Final Architecture Assessment (A–F), Scalability Model, Prioritized Remediation Plan, Open Questions, and Final Production-Readiness Score.*
