# Rate limiting

Every limit below is enforced in `backend/src/middleware/rateLimiter.js` and
applied in the route files named in the table. All enforcement is server-side;
the frontend has no part in it, so a modified client, a direct `curl`, or a
script cannot bypass any of this.

Verified by `backend/tests/rateLimiter.test.mjs` — 18 tests, all passing,
including real HTTP requests that assert a genuine `429` is returned once a
budget is spent.

## Why the previous implementation was inadequate

Three defects, all fixed:

**1. Campus NAT collapsed thousands of students into one quota.**
Every limiter keyed on IP address. ABUAD students share a small number of
outbound addresses, so the 5-per-hour ticket limit was effectively 5 per hour
*for the whole university*. The first five submissions of the day locked
everyone else out. This is a self-inflicted denial of service, not protection.

Fixed by keying authenticated traffic on the user id (`identityKey`), so each
student carries their own budget. Proven by the test
*"two identities do not consume each other budget on one IP"*.

**2. IPv6 clients could rotate for a fresh quota.**
A full IPv6 address as the key means an attacker with a normal /64 allocation
gets ~18 quintillion free buckets. `ipBucket()` now truncates IPv6 to its /64
prefix, so the whole allocation shares one bucket. IPv4-mapped addresses
(`::ffff:1.2.3.4`) are unwrapped so one client isn't accidentally two.

**3. Most abuse-prone endpoints had no limiter at all.**
Comment creation, notification reads, and every admin mutation were covered
only by the 600-request global limiter — enough headroom to post hundreds of
abusive comments a minute.

## Limits

| Endpoint | Limit | Window | Keyed on | Rationale |
|---|---|---|---|---|
| **All `/api/*`** | 600 | 15 min | identity | Backstop only. A normal dashboard session makes ~20–40 requests, so this is ~15× typical use — it catches runaway loops without touching real users. |
| `POST /api/auth/login`<br>`POST /api/auth/signup`<br>`POST /api/auth/forgot-password`<br>`POST /api/auth/reset-password` | **10** | 15 min | **IP /64** | Credential stuffing and password-reset abuse. Deliberately IP-keyed, not identity-keyed: there is no trusted identity before login, and account creation must be capped per host or one attacker mass-registers. `skipSuccessfulRequests` is on, so only *failures* count — a student who signs in correctly ten times in a row is never blocked. |
| `POST /api/auth/check-email` | 40 | 15 min | IP /64 | Account-enumeration oracle. Higher than login because the signup form calls it legitimately as users correct typos, but far below what enumeration needs. |
| `POST /api/tickets` | 15 | 1 hour | identity | Was 5/hour/IP, which throttled the whole campus. 15 per student per hour is generous for genuine reporting and still caps flooding. |
| `POST /api/tickets/:id/comments` | **20** | 5 min | identity | Tighter than general interaction: each comment runs the moderation matcher, fans out notifications, and is publicly visible — the most attractive spam target on the API. |
| Votes, ratings, reopen | 60 | 5 min | identity | Cheap, idempotent, and chatty. Browsing and upvoting a board of tickets should never trip a limit. |
| `GET /api/notifications/*`<br>`PATCH .../read` | 150 | 5 min | identity | The bell polls. 150/5min ≈ one request every 2s, well above the 60s poll interval, so a legitimate client has ~30× headroom while a broken retry loop is still stopped. |
| Uploads (`/api/uploads/*`) | 30 | 15 min | identity | Bandwidth and storage cost. Covers a realistic attachment session; blocks bulk-dumping into storage. |
| Feedback submission | 10 | 1 hour | identity | Directly answers the brief's "do not allow unlimited feedback". |
| Admin/super-admin mutations | 100 | 5 min | identity | Not distrust of admins: it caps the blast radius of a stolen privileged session and stops a looping script rewriting portal config. Applied to settings updates, role changes, status changes, and anonymous-author reveals. |

## Response on exceeding a limit

```
HTTP 429 Too Many Requests
RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset   (standard headers)
Retry-After: <seconds>

{ "error": "<human-readable explanation>", "retryAfterSeconds": 900 }
```

The body states what happened and when to retry, and nothing else. It does not
reveal the bucket key, the keying strategy, remaining quota beyond the standard
headers, or the store implementation — asserted by the test *"the 429 body
explains the limit without leaking internals"*.

Rate-limit keys are hashed before they reach a log line. The token fallback
uses a SHA-256 prefix, never the raw bearer token, so 429 log entries can't
leak a credential into log storage.

## Ensuring legitimate users are not blocked

- Per-user keying (the main fix) — one heavy user cannot affect another.
- `skipSuccessfulRequests` on auth, so correct sign-ins are never counted.
- Limits set from realistic usage, not round numbers: the notification limiter
  sits ~30× above the actual poll rate.
- Reads are treated differently from writes; writes that trigger side effects
  (comments, tickets, feedback) are tightest.
- Health and diagnostic endpoints are exempt so uptime monitoring cannot
  exhaust a quota and mask an outage.

## Known limitation — must be addressed before multi-instance deployment

The store is **in-memory**. On a single instance this is correct and fast. If
the API is ever scaled to more than one process or container, each instance
keeps its own counters, so effective limits multiply by the instance count.

Fix when scaling: swap in `rate-limit-redis` and point it at a shared Redis.
`build()` in `rateLimiter.js` is the single place a `store` needs to be passed,
so this is a contained change. Until then, the deployment must remain
single-instance for these limits to hold as documented.
