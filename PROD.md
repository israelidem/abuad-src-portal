# Production Deployment

How to get the live site working. Read the diagnosis first — it explains
*why* the login loop happens, which makes the steps make sense.

---

## The diagnosis

Signing in on `abuad-src-portal.vercel.app` flashes the dashboard and
throws you back to `/login`. The browser console shows:

```
GET https://abuad-src-portal-backend.onrender.com/api/auth/me  404 (Not Found)
```

That 404 is the whole problem. The frontend can't load your profile, so
the route guard sees an unauthenticated user and redirects. The password
was correct; the app just can't confirm who you are.

### Why the API 404s

Render is building the current code, but the server **crashes on startup**:

```
Error: Missing required environment variable(s):
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL
  at file:///opt/render/project/src/backend/src/config/env.js:67
```

`backend/src/config/env.js` validates config at import time and throws if
anything is missing, so misconfiguration fails loudly instead of at the
first request. Render sees the crash, marks the deploy failed, and **keeps
serving the last deploy that succeeded** — which is the old MongoDB API
from before the Supabase rewrite.

You can see the old code answering right now:

```bash
curl https://abuad-src-portal-backend.onrender.com/
# {"message":"ABUAD SRC Portal API is running smoothly!"}
```

That string doesn't exist anywhere in this repo. It's only in the initial
commit. The old API had `/signup`, `/verify-otp`, `/login` and
`/forgot-password` — no `/me`, no `/tickets/stats`. Hence the 404s.

**So: this is a configuration problem, not a code problem.** Nothing in
the backend needs rewriting. It needs its environment variables.

### Do you still need Render?

Yes. Supabase replaced your *database* (MongoDB → Postgres) and now also
handles auth and file storage. It does not host your Express API. The
request path is:

```
Browser (Vercel)  ->  Express API (Render)  ->  Supabase (Postgres + Auth)
       |                                              ^
       +-- signs in directly with supabase-js --------+
```

Login and token refresh go browser-to-Supabase directly. Everything
else — tickets, comments, profiles, the role check behind `/api/auth/me` —
goes through Render. Drop Render and the app has no API.

---

## Step 1 — Collect the values

Two tabs in your Supabase dashboard.

### Settings → API

| Field | Goes to |
|---|---|
| Project URL | `SUPABASE_URL` |
| `anon` `public` key | `SUPABASE_ANON_KEY` |
| `service_role` `secret` key | `SUPABASE_SERVICE_ROLE_KEY` |

> **The service-role key bypasses Row Level Security.** Backend only.
> Never put it in `frontend/.env`, never prefix it with `VITE_`, never
> commit it. If it ever leaks, rotate it immediately on that same page.

### Settings → Database → Connection pooling

Copy the **Transaction** mode string (port **6543**) for `DATABASE_URL`.

You want the pooled one, not the direct connection:

```
postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&connect_timeout=30&sslmode=require
```

The query string is required, not decoration:

- `pgbouncer=true` — disables prepared statements, which the pooler
  doesn't support. Without it Prisma reports a misleading
  *"Can't reach database server"* even though the network is fine.
- `connection_limit=1` — one connection per instance. The pooler handles
  fan-out. Free-tier Postgres will refuse connections without this.
- `connect_timeout=30` — free-tier projects sleep when idle and need a
  moment to wake.

Replace `[password]` with your **database** password (Settings → Database
→ Reset database password), not your Supabase account password. If it
contains any of `@ # $ % / : ?` you must percent-encode it or the URL
won't parse — easiest to reset it to letters and digits only.

---

## Step 2 — Set the variables in Render

Dashboard → `abuad-src-portal-backend` → **Environment** → add each:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SUPABASE_URL` | Project URL from step 1 |
| `SUPABASE_ANON_KEY` | anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
| `DATABASE_URL` | pooled string, port 6543 |
| `ALLOWED_ORIGINS` | `https://abuad-src-portal.vercel.app` |

Don't set `PORT` — Render injects it and `server.js` reads it.

`ALLOWED_ORIGINS` is the one that catches people out. Once the API boots,
CORS rejects any origin not on this list, and a blocked request looks
almost identical to the bug you're fixing. Use the exact scheme and host,
**no trailing slash**:

```
https://abuad-src-portal.vercel.app        correct
https://abuad-src-portal.vercel.app/       wrong — trailing slash
http://abuad-src-portal.vercel.app         wrong — http
```

Add preview deployments comma-separated if you use them.

Save. Render redeploys automatically.

---

## Step 3 — Confirm settings match the blueprint

Under **Settings**, verify:

| Setting | Value |
|---|---|
| Root Directory | `backend` |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

`render.yaml` in the repo root now declares all of this, so it stays put.

Two things were missing before and are now fixed in the repo:

- **`postinstall: prisma generate`** in `backend/package.json`. Prisma
  generates a client from your schema into `node_modules`; that output
  isn't committed. Without this hook the client never exists and
  `import { PrismaClient }` throws on boot.
- **`engines: { node: "22.x" }`**. Render was defaulting to Node 24;
  Prisma 5.22 targets 18/20/22. Precautionary rather than a confirmed fix.

---

## Step 4 — Watch the deploy

**Logs** tab. Success looks like:

```
==> Running 'npm start'
[server] listening on port 10000 (production)
```

If you see the `Missing required environment variable(s)` error again, it
names exactly which ones — recheck spelling in step 2.

---

## Step 5 — Verify the API

```bash
curl -i https://abuad-src-portal-backend.onrender.com/health
```

Expect `200` and `{"status":"ok","db":"connected",...}`.

`503` with `"db":"unreachable"` means Express started but Postgres
didn't answer — recheck `DATABASE_URL`, especially `pgbouncer=true`.

Then the endpoint that was failing:

```bash
curl -i https://abuad-src-portal-backend.onrender.com/api/auth/me
```

**Expect `401 {"error":"Authentication required."}`.**

A 401 here is success. It means the route exists and correctly rejected a
request with no token. That is the exact thing that was 404ing.

Also confirm the old code is gone:

```bash
curl https://abuad-src-portal-backend.onrender.com/
# want: {"name":"ABUAD SRC Portal API","version":"2.0.0","status":"running"}
```

If you still see `"running smoothly!"`, the new deploy hasn't taken over.

> First request after idle takes ~50s on the free plan while the instance
> wakes. Not a bug. It does mean a cold sign-in can feel broken, so
> consider pinging `/health` on a schedule.

---

## Step 6 — Point the frontend at the API

Vercel → project → **Settings** → **Environment Variables**:

| Key | Value |
|---|---|
| `VITE_SUPABASE_URL` | same as `SUPABASE_URL` |
| `VITE_SUPABASE_ANON_KEY` | anon key — **anon only** |
| `VITE_API_URL` | `https://abuad-src-portal-backend.onrender.com` |

**Then redeploy.** This is not optional. Vite inlines `VITE_*` values into
the bundle at *build* time; they are not read at runtime. Changing them
without rebuilding changes nothing. Deployments → latest → **Redeploy**.

No trailing slash on `VITE_API_URL` — paths are joined directly and
`//api/auth/me` will 404.

---

## Step 7 — Supabase auth URLs

**Authentication → URL Configuration**

- Site URL: `https://abuad-src-portal.vercel.app`
- Redirect URLs: add `https://abuad-src-portal.vercel.app/reset-password`

Without these, password-reset links bounce to localhost.

---

## Step 8 — Ticket numbers (SQL done; needs a deploy)

Ticket submission failed with `Argument 'ticketNumber' is missing`.

`01_post_migration.sql` defined `next_ticket_number()` but never attached
it to the column, so nothing ever called it. `ticket_number` is `NOT NULL`
with no default, and the API doesn't supply one — `ticketRoutes.js` was
written expecting the database to. The comment above that handler says
*"ticket_number is assigned by a Postgres sequence"*, which was the
intent; it just wasn't wired up.

The fix has two halves and needs both:

| Half | What it does | Status |
|---|---|---|
| `alter column ... set default` in SQL | Postgres fills the value | **Applied** ✅ |
| `@default(dbgenerated(...))` in `schema.prisma` | Prisma stops demanding it | **Needs deploy** |

**You already ran the SQL** — verified against your database:

```
column_default : next_ticket_number()
function exists: true
```

So the remaining work is deploying the schema change. That error message
comes from Prisma's *client-side* validation, which runs before any SQL is
sent. Render is still using a client generated from the old schema, where
`ticketNumber` is required — so it rejects the insert without ever asking
Postgres. The database is ready; the deployed code isn't.

**Push the commits.** Render's `postinstall` runs `prisma generate` on
build, which regenerates the client from the updated schema. No further
Supabase work needed.

Verified locally against your real database: creating a ticket without
passing `ticketNumber` produced `SRC-000001` (inside a rolled-back
transaction, so nothing was persisted).

If you ever need to re-check the database side:

```sql
select column_default from information_schema.columns
 where table_name = 'tickets' and column_name = 'ticket_number';
-- want: next_ticket_number()
```

---

## Step 9 — Test

1. Open the site in a **private window** (avoids a stale cached bundle)
2. Sign in
3. You should land on `/dashboard` and stay there
4. Submit a test ticket — expect an `SRC-000001`-style number

If you're still redirected, open DevTools → Network → the `/api/auth/me`
request and use the table below.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/api/auth/me` → **404** | Old code still serving; new deploy failed | Render logs; steps 2–4 |
| `/api/auth/me` → **401** on the *site* but curl works | Token not attached — usually stale bundle | Redeploy Vercel (step 6), retry in private window |
| **CORS policy** error in console | Origin missing from `ALLOWED_ORIGINS` | Step 2. Exact origin, no trailing slash |
| `Missing required environment variable(s)` | Vars unset or misspelled | Step 2 — the error names them |
| `Can't reach database server` | `pgbouncer=true` missing, or wrong port | Use pooled 6543 string, full query params |
| `@prisma/client did not initialize yet` | `prisma generate` didn't run | `postinstall` is now in `package.json`; redeploy |
| **502** for ~50s then works | Free-tier cold start | Expected. Ping `/health` periodically |
| `Profile not found.` (401) | Auth user exists, no `profiles` row | Trigger missing — rerun `01_post_migration.sql` (SETUP.md step 2) |
| Login works, dashboard empty | API up, RLS blocking reads | Confirm `01_post_migration.sql` ran fully |
| `Argument 'ticketNumber' is missing` | Old Prisma client deployed (schema change not pushed) | Step 8 — push, let `postinstall` regenerate |
| `duplicate key ... ticket_number_key` | Sequence behind existing rows | Rerun the `setval(...)` block in `01_post_migration.sql` |

### Reading `/api/auth/me` correctly

| Status | Meaning |
|---|---|
| **404** | Route doesn't exist. **Wrong/stale code deployed.** |
| **401** | Route exists, no valid token. **Correct** when unauthenticated. |
| **200** | Route exists, token valid, profile returned. Fully working. |

404 → 401 is the transition that proves this is fixed.

---

## What changed in the repo

Alongside this guide:

- `backend/package.json` — added `postinstall: prisma generate` (the
  actual deploy blocker), a `build` script, and `engines.node = 22.x`
- `render.yaml` — build/start/health/rootDir in version control
- `backend/scripts/smoke-routes.mjs` — boots the API with dummy env vars
  and asserts routes are mounted. `npm --prefix backend run smoke`.
  Catches "wrong code deployed" locally, before pushing.

Separately, two genuine code bugs were fixed while tracing this. Neither
caused the production failure, but both would have caused the same
redirect once the API was reachable:

- **Sign-in race.** `signIn()` resolved as soon as Supabase validated the
  password, before the profile loaded. `Login` navigated immediately and
  the guard evaluated `isAuthenticated` — false, because the profile was
  still null — and redirected. `signIn()` now awaits the profile, and
  guards wait on a new `resolving` flag covering the window where a
  session exists but its profile hasn't arrived.
- **Response shape mismatch.** `GET /api/auth/me` returned `{ user }`
  while `AuthContext` destructured `{ profile }`, so the profile was
  always `undefined` — a silent failure behind a 200. Same bug on
  `PATCH /me`, which would have blanked the profile on save.

---

## Quick reference

```bash
# Is the new code live?
curl https://abuad-src-portal-backend.onrender.com/
# want {"name":"ABUAD SRC Portal API","version":"2.0.0",...}

# Is the DB connected?
curl https://abuad-src-portal-backend.onrender.com/health
# want {"status":"ok","db":"connected",...}

# Is the route that was 404ing alive?
curl -i https://abuad-src-portal-backend.onrender.com/api/auth/me
# want 401, NOT 404

# Locally, before pushing
npm --prefix backend run smoke
npm run build
```
