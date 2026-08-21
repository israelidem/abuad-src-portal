# Load testing (task §5) — status: NOT DONE, and why

## The bottom line, first

**I did not run the 100 / 500 / 2,500 / 5,000 concurrent-student load test,
and I cannot give you success rates, p95/p99 latencies, throughput or CPU
figures for those tiers.** There is no table of results below because any
table I produced from this environment would be fiction dressed as evidence.

The task said: *"Do not claim that the application supports 5,000 concurrent
students unless the test results actually support that conclusion."* The
matching honest statement is that **the capacity of this application at any
of those four tiers is currently unknown.**

## Why this environment cannot answer the question

`scripts/capacity-model.mjs` printed the host it ran on:

```
host : 2 logical CPUs, 4.1 GB RAM
```

Four independent reasons a load test from here would be misleading:

1. **The load generator would compete with the server for 2 CPUs.** At 5,000
   virtual users the generator becomes the bottleneck, and the latencies
   recorded would be its scheduling delay, not the app's response time. This
   fails silently in the direction that makes results look *worse*, so it
   can't even be dismissed as conservative.
2. **The database is remote and shared.** `backend/.env` points at hosted
   Supabase. Every query crosses the public internet from a residential
   connection, so measured latency is dominated by RTT and by whatever else
   is running on that shared instance. It measures my network, not the code.
3. **Hammering a shared hosted database with 5,000-user write load is
   abusive** to a multi-tenant service and risks rate-limiting or suspension
   of the project's own instance.
4. **The production host is not this laptop.** Render's free/starter tier
   behaves differently again (cold starts, single small instance, its own
   connection limits). Numbers from here would not transfer.

Running the test anyway and publishing the output would satisfy the letter of
§5 while actively misinforming a deployment decision. I chose not to.

## What I did measure, and what it bounds

### 1. Moderation CPU ceiling — measured

`scripts/capacity-model.mjs`, `scripts/resolve-discrepancy.mjs`. Comment
moderation is synchronous and blocks the event loop, so it sets a hard
ceiling on comment submissions per process:

| metric | value |
|---|---|
| terms scanned | 400 (the enforced cap) |
| body | 1,944 chars, pangram = worst case for the prefilter |
| steady-state cost | **~1.6 ms** (converged across 4 harness variants) |
| sustained over 3 s | ~2.1 ms |
| **ceiling, 1 process** | **~470 comment submissions/sec** |

Getting to a trustworthy version of this number required discovering that
three of my own earlier benchmarks were measuring V8's JIT warm-up rather
than the code, disagreeing by up to 7x. That story is in
`PERF_MODERATION.md`; it is the reason I distrust single-run benchmarks here.

**What it bounds:** comment submission throughput, on this hardware, for
that one code path. Nothing else.

### 2. Rate limits — an analytic bound that makes the tiers less alarming

From `RATE_LIMITS.md`, comment submission is capped at 10/min/user. So 5,000
students *fully saturating* their own comment allowance would generate:

```
5,000 users x 10 comments/min / 60 = ~833 comment submissions/sec
```

against a measured single-process ceiling of ~470/sec. That is the one
concrete, defensible capacity statement available: **a single process is
roughly 1.8x short of absorbing 5,000 students all writing comments at their
maximum permitted rate**, and would need ~2 processes for that pathological
case. Real students do not write 10 comments a minute, so this is a
worst-case bound, not a forecast — but it is derived from a measurement and
a configured limit rather than from optimism.

This tells you nothing about logins, dashboard reads, or uploads.

### 3. Untested paths that I specifically expect to fail first

Ranked by my suspicion, all **unverified**:

1. **Database connections.** Prisma's default pool is small; hundreds of
   concurrent requests will queue on connections long before CPU saturates.
   This is my prime suspect for the real first bottleneck at 500+.
2. **Login.** bcrypt is deliberately expensive (~100 ms+ of CPU each) and
   synchronous-ish under load. A 5,000-student 9 a.m. login stampede is a
   far more realistic failure mode than comment volume, and I have not
   measured it at all.
3. **Uploads.** Each Cloudinary upload holds a request open through a
   third-party round trip; concurrency here is bounded by the remote service
   and by memory held per in-flight buffer.
4. **Notification polling.** Reduced during this work, but the per-client
   interval multiplied by 5,000 clients is a steady background read load I
   have not measured.

## A real finding that load testing would have exposed

Worth flagging because it is architectural, not a tuning knob:

**The rate limiter is in-memory** (`src/middleware/rateLimiter.js`). Its
counters live in one process's heap. The moment the app is scaled to more
than one instance or process — exactly what the numbers above say is needed
to survive 5,000 students — **every limit silently multiplies by the
instance count**, and a round-robin load balancer lets an attacker get N
times the intended allowance. The fix is a shared store (Redis) for the
counters. This is listed in the final report's remaining recommendations and
should be treated as a prerequisite for horizontal scaling, not an
optimisation.

## How to actually run §5

For someone with a suitable environment, in priority order:

1. **Deploy to a staging host that mirrors production**, with its own
   database instance (not the shared production Supabase project).
2. **Drive load from outside that host** — a separate machine or a hosted
   runner — so the generator never competes with the server for CPU.
3. **Use k6 or Artillery** with a scenario weighted to real behaviour, not
   one endpoint: roughly 60% dashboard/ticket reads, 20% notification polls,
   10% comment submissions, 5% logins, 5% uploads.
4. **Ramp, don't step:** 100 → 500 → 2,500 → 5,000 with a plateau at each
   tier long enough to see whether latency stabilises or creeps. Creeping
   latency at a fixed user count means a leak or unbounded queue, which a
   short burst test hides.
5. **Instrument the server side too** — event-loop lag, RSS, Prisma pool
   wait time, and `pg_stat_statements` for slow queries. Client-side
   latency alone tells you that it broke, not where.
6. **Raise the rate limits or exempt the load-test identity**, or the test
   will measure the rate limiter returning 429s rather than the application.

## Summary table (as required by §16, filled in honestly)

| tier | success/error rate | avg | p95/p99 | throughput | resources | stable? |
|---|---|---|---|---|---|---|
| 100 | not measured | — | — | — | — | unknown |
| 500 | not measured | — | — | — | — | unknown |
| 2,500 | not measured | — | — | — | — | unknown |
| 5,000 | not measured | — | — | — | — | unknown |

The only quantitative claims I stand behind are the two in "What I did
measure": ~1.6–2.1 ms and ~470 comment moderations/sec per process on a
2-CPU host, and the ~833/sec worst-case demand those limits permit at 5,000
users. Everything else in §5 remains open.
