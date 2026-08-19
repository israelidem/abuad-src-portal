# Backend deployment — cold starts, and whether Vercel fixes them

Written during the Phase 8/9 performance work. This is the analysis the
task asked for *before* changing any deployment configuration, because
migrating first and discovering the incompatibilities afterwards is how a
testing environment becomes less reliable than the one it replaced.

**Recommendation: do not migrate to Vercel yet.** The measurements below
show most of the pain was not Render, and the one genuine blocker is
cheap to fix on Render but expensive to work around on serverless.

---

## What was actually measured

Two separate complaints, per the audit: cold starts (Problem A) and
"slow even when warm" (Problem B). They have different causes, and
Problem B was the larger of the two.

### Problem B — warm slowness was ours, not Render's

`npm run measure` against a warm local server, and `npm run verify:cache`
against the same:

| Request | Before | After |
|---|---|---|
| `GET /api/auth/me` (first, cold cache) | ~2540 ms | ~2540 ms |
| `GET /api/auth/me` (repeat, warm) | ~250 ms | **7 ms** |

Every authenticated request was paying for:

1. `supabase.auth.getUser(token)` — a network round trip to Supabase Auth
   (~200 ms from Nigeria), then
2. a `profiles` row lookup for role and active status.

That is per request, not per session. A dashboard that fires four API
calls paid it four times. This was the dominant cost of "feels slow when
warm" and it had nothing to do with the host.

Fixed in `backend/src/services/authCache.js` — a ~6 second in-process
cache keyed on a SHA-256 hash of the token. See the security notes in
that file; the short version is that it is capped by the token's own
`exp`, invalidated explicitly on role change / deactivation / profile
edit, and never caches failures.

Verified live: 10/10 checks in `npm run verify:cache`, including that a
deactivated account is rejected on the *very next* request with no TTL
wait.

### Problem A — cold starts are real but narrower than assumed

Render's free tier sleeps after ~15 minutes idle; the wake-up is roughly
30–50 seconds. `.github/workflows/keepalive.yml` already pings the health
endpoint, which reduces but does not eliminate this — GitHub Actions cron
is not punctual, and the ping stops mattering the moment a gap exceeds
the sleep threshold.

Worth noting: the 2540 ms first request above is *not* a Render cold
start. That was a local server. It is Prisma's first connection plus the
first Supabase Auth call — which means part of what students experience
as "cold start" would follow us to any host, serverless included.

---

## Is the Express app serverless-compatible?

Audited against the things that break under a per-request function model.

### Compatible

- **No long-running processes.** One `app.listen` in `server.js`, no
  workers, no queues.
- **No scheduled jobs.** Nothing in the codebase uses `setInterval` or
  cron. The only scheduled thing is the external GitHub keepalive, which
  becomes unnecessary on serverless rather than broken.
- **No work continues after the response.** The announcement fan-out is
  `await`ed inside the handler, so there is no detached promise that a
  frozen function would kill mid-flight. This is the single most common
  serverless porting bug and the code already avoids it.
- **Web Push is not a persistent connection.** `pushService.js` makes
  ordinary outbound HTTPS calls to the push endpoints per subscription.
  Service workers live in the browser and are unaffected by where the API
  runs.
- **VAPID keys are environment variables**, not files on disk.

### Needs attention before any migration

1. **The announcement broadcast is synchronous fan-out.**
   `broadcastAnnouncement()` in `announcementRoutes.js` loads every
   recipient and pushes in chunks, inside the request. On Render this can
   take as long as it needs. On Vercel's free tier the function is killed
   at 10 seconds, so a broadcast to a few thousand students would be cut
   off partway — with notification rows written for the students it
   reached and not for the rest, and no record of where it stopped.

   This is a correctness problem, not just a slowness problem, and it is
   the reason not to migrate casually.

2. **Prisma connection pooling.** Each warm serverless instance opens its
   own pool. Supabase's Postgres has a connection ceiling, and enough
   concurrent instances will exhaust it — the failure looks like random
   `too many connections` errors under load rather than a clean slowdown.
   Requires Supabase's pooler (port 6543, transaction mode) via
   `DATABASE_URL`, keeping the direct connection for `DIRECT_URL` so
   migrations still work.

3. **The session cache becomes per-instance.** Correctness holds — the
   TTL is short and bounded — but the hit rate falls, because consecutive
   requests may land on different instances. The 7 ms figure above would
   partially regress. It would not become *wrong*, only less effective.

4. **Rate limiting becomes per-instance.** `express-rate-limit` uses an
   in-memory store, so limits multiply by the number of live instances. A
   5-attempt login limit effectively becomes 5 × instances. This weakens
   a security control, and fixing it properly needs a shared store.

---

## Recommended sequence

**Now (done):** the session cache. This addressed the complaint students
actually described — sluggishness during a session — and it benefits every
host equally, including the school's eventual production server.

**Next, if cold starts still hurt during testing:** the cheapest real fix
is Render's paid tier (~\$7/month), which removes sleeping entirely and
requires zero code change, zero new failure modes, and no re-architecture
of the broadcast. Given that production is likely Hostinger — a
long-running Node host, architecturally the same as Render — this also
avoids building serverless-shaped workarounds that would then need
unwinding.

**Only if free hosting is a hard requirement:** migrate, but do items 1–4
above first, in that order. Item 1 in particular means moving the fan-out
out of the request path, which is a real piece of design work (a
`notification_queue` table drained by a scheduled function, or Supabase
Edge Functions) and not a deployment change.

---

## If migrating anyway — the mechanical steps

Recorded for completeness. Not executed.

1. `backend/api/index.js` exporting the app without `app.listen`:
   ```js
   import app from '../server.js';   // requires splitting app from listen
   export default app;
   ```
   `server.js` currently calls `app.listen` at module scope, so it needs
   splitting into `app.js` (exports the app) and `server.js` (listens) —
   the listen call must not run in a serverless import.
2. `backend/vercel.json` routing all paths to that function.
3. `DATABASE_URL` → Supabase pooler, `DIRECT_URL` → direct connection.
4. Re-point `VITE_API_URL` in the frontend environment.
5. Set every variable from `backend/.env.example` in the Vercel project,
   service-role key included — server-side only, never `VITE_`-prefixed.
6. Re-run `npm run verify:all` against the deployed URL via
   `VERIFY_BASE_URL`, because the RLS and settings guarantees are
   properties of the deployment, not of the source tree.

---

## Manual configuration still required

Independent of hosting:

- `backend/prisma/sql/06_security_hardening.sql` and `08_settings_registry.sql`
  must be applied to Supabase (see `PROD.md`). RLS is not in the Prisma
  schema, so `prisma migrate` will not apply it.
- VAPID keys must be set for push to work at all
  (`npx web-push generate-vapid-keys`).
