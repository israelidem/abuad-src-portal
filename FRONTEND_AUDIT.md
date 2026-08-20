# Frontend Audit — Performance, Theming, Loading States

Scope: `frontend/` only. Backend hardening is already covered in
`HARDENING_REPORT.md` and is not revisited here.

Everything below was measured or grepped, not inferred from reading prose.
File:line references are given so each item can be checked independently.

---

## 1. What was measured

`npm run build` in `frontend/`, production mode, current `HEAD`:

| Chunk | Raw | Gzip |
|---|---|---|
| `index-*.js` (entry) | 469.76 kB | **136.25 kB** |
| `Analytics-*.js` | 406.08 kB | **114.41 kB** |
| `index-*.css` | 43.22 kB | 8.17 kB |
| `TicketDetail-*.js` | 18.35 kB | 5.30 kB |
| `NewTicket-*.js` | 14.35 kB | 5.02 kB |
| every other route chunk | ≤ 8.5 kB | ≤ 3.3 kB |

Route splitting is already working — 20+ separate route chunks, all small.
The two large numbers are the whole story.

---

## 2. Findings, ranked

### F1 — Dark mode: stat numbers are invisible (highest severity, trivial fix)

`AdminDashboard.jsx:59` and `Dashboard.jsx:33` declare the stat colour as a
bare string with no dark variant:

```js
['Total',    stats?.total ?? 0, 'text-slate-900'],
['Reported', stats?.total ?? 0, 'text-slate-900'],
```

That string is interpolated at `AdminDashboard.jsx:65`:

```jsx
<dd className={`text-2xl font-bold ${colour}`}>{value}</dd>
```

The card behind it is `dark:bg-slate-900` (`AdminDashboard.jsx:64`). So in
dark mode this is `slate-900` text on a `slate-900` background — the single
most important number on each dashboard renders invisible. The other three
entries in the same array use `text-red-600` / `text-amber-600` /
`text-green-600`, which survive on both backgrounds, which is why this
slipped through.

### F2 — Dark mode: ten controls with no `dark:` variant

These are hard-coded light surfaces with no dark counterpart. Each is a
white or near-white box on a dark page:

| File:line | Class | Effect in dark mode |
|---|---|---|
| `TicketFilters.jsx:46` | `bg-white` in `selectClass` | all filter dropdowns stay white |
| `TicketFilters.jsx:62` | search input, `dark:border-slate-700` only | white field, dark border |
| `NewTicket.jsx:354` | `border-slate-200 bg-white hover:border-slate-300` | unselected privacy card is white |
| `NewTicket.jsx:167` | `inputClass`, no dark bg/text | white inputs |
| `StaffControls.jsx:111` | `inputClass`, no dark bg/text | white inputs |
| `NotificationBell.jsx:184` | `hover:bg-slate-50` | hover flashes near-white |
| `NotificationSettings.jsx:25` | `bg-slate-100 text-slate-500` | white icon chip when unsubscribed |
| `NotificationSettings.jsx:62` | `border-slate-300 text-slate-700 hover:bg-slate-50` | unreadable "turn off" button |
| `TicketCard.jsx:141` | `hover:border-slate-300 hover:text-slate-700` | upvote hover goes dark-on-dark |
| `TicketDetail.jsx:218` | `border-slate-300 text-slate-600 hover:bg-slate-50` | same |

Note these are *inconsistent* rather than uniformly missing — `TicketCard`
line 68 and `TicketDetail` line 129 do carry full dark variants. So the
pattern is established and correct in most of the codebase; these ten are
the stragglers. `frontend/scripts/add-dark-variants.mjs` exists, which
suggests a previous pass was automated and these are what it couldn't
match (they're all inside template literals or ternaries, which a naive
class-string rewriter would skip). That explains the shape of the gap.

Minor, same family: `ErrorBoundary.jsx:38` uses `dark:bg-slate-900` where
`Layout.jsx:177` uses `dark:bg-slate-950`. The error screen is a slightly
different black from the app. Cosmetic.

### F3 — `Analytics` pulls 114 kB gzip for six charts

`Analytics-*.js` is 406 kB / 114 kB gzip, essentially all `recharts`
(`Analytics.jsx:10-24` imports Bar, BarChart, CartesianGrid, Cell, Legend,
Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis).

Two things make this less bad than it looks, and one that makes it worse:

- It *is* code-split, so students never download it. Only staff hitting
  `/analytics` pay.
- The `CHART_THEME` work at `Analytics.jsx:55-70` is genuinely good — it
  correctly identifies that recharts renders inline SVG attributes that
  Tailwind `dark:` cannot reach, and themes only the chrome while leaving
  the semantic series colours alone. That reasoning is sound and I would
  not undo it.
- But `AdminDashboard.jsx:20-33` already implements a `Bar` component with
  plain CSS and a comment explicitly saying *"a few dozen KB saved for a
  handful of rows"*. So the codebase contains two answers to the same
  question, and the expensive one won on the page that arguably needs it
  least.

This is a judgement call, not a defect. Flagging it, not asserting a fix.

### F4 — No vendor chunk: every deploy re-downloads React

`vite.config.js` is 11 lines with no `build.rollupOptions.manualChunks`.
React, react-dom, react-router-dom and `@supabase/supabase-js` are all
bundled into `index-*.js`. That chunk is content-hashed as a unit, so
changing one line of `App.jsx` invalidates all 136 kB gzip for every
returning user, including the ~110 kB of it that is unchanged vendor code.

Splitting vendors into their own chunk makes repeat visits after a deploy
near-free. This is the highest-leverage performance change available and
it carries no behavioural risk.

`@supabase/supabase-js` cannot be lazily loaded — `AuthContext` needs it at
module scope to restore the session on first paint — so it stays in the
eager path either way. It just shouldn't share a cache key with app code.

### F5 — Service worker can white-screen the tab after a deploy

`sw.js:37` calls `skipWaiting()` inside `install`, and `sw.js:48` calls
`clients.claim()` in `activate`. Together these hand control to a new
worker mid-session.

The already-loaded page still holds the *old* chunk filenames in memory.
If the user then navigates to a lazy route, the browser requests an asset
hash that no longer exists on the origin. `isHashedAsset` (`sw.js:59`)
sends it to `fetch`, which 404s, and React's lazy import rejects — blank
region or an ErrorBoundary trip, on a user who did nothing wrong.

The caching policy itself is well-reasoned and I want to be clear about
that: the `isPrivate` check at `sw.js:54-57` correctly refuses to cache
`/api/*`, Supabase and `/auth/*`, and the comment explaining why (shared
phones, misleading stale ticket state) is exactly the right instinct. The
bug is narrowly in the update *choreography*, not the policy.

`CACHE_VERSION = 'v1'` (`sw.js:24`) is also static, so the shell cache is
never evicted across deploys. Lower impact — the shell is only served on
an offline cold start (`sw.js:92-110`) — but it means an offline launch can
show an `index.html` from an arbitrarily old deploy.

### F6 — `Analytics` loads behind a bare spinner

`Analytics.jsx:30` imports `Spinner`, not a skeleton. `Spinner.jsx:57-79`
provides `TicketCardSkeleton`, and `AdminDashboard.jsx:108-113`,
`Dashboard`, and `TicketList` all use it correctly. Analytics — the page
with the *most* layout to hold, six chart cards — gets a centred spinner
and therefore a full reflow when data lands.

Worth noting `Spinner.jsx:40-47` documents a previously-fixed bug where a
missing space collapsed skeletons to zero height. That comment is useful
and should stay.

---

## 3. Proposed plan

Ordered by confidence and risk. I'd suggest stopping after Phase 2 and
looking at the result before going further.

**Phase 1 — dark mode correctness** (F1, F2)
Purely additive class changes, no logic touched. Fixes one invisible-text
bug and ten light-surface stragglers. Verify by toggling the theme on
`/admin`, `/tickets`, `/tickets/new`, `/profile`.

**Phase 2 — vendor chunking** (F4)
Add `manualChunks` to `vite.config.js` splitting `react`/`react-dom`/
`react-router-dom` and `@supabase/supabase-js` into stable chunks.
Re-run the build and compare. Expected: entry chunk drops to roughly
25–35 kB gzip of app code, with vendors in separately-cached chunks.
Measurable, so we'll know rather than assume.

**Phase 3 — service worker update flow** (F5)
Drop `skipWaiting()` from `install`. Let the new worker wait, and either
activate on the next cold start or prompt the user. Also derive
`CACHE_VERSION` from the build rather than a hand-edited `'v1'`.
This one needs a decision from you: **silent wait** (simplest, update
lands next launch) or **"a new version is available, reload"** toast
(better, more code). I'd default to silent wait.

**Phase 4 — Analytics skeleton** (F6)
Add a chart-card skeleton mirroring the `Stat` and `section` layout.

**Not proposed, flagged only** (F3)
Replacing recharts with the existing CSS-bar approach would save ~114 kB
gzip on one staff-only route, but would cost the line chart and the
already-correct `CHART_THEME` work. I don't think that trade is obviously
right and I'd rather you decide than have me quietly rewrite it.

---

## 4. Confidence

- F1, F2, F4, F6 — verified by direct grep and file read. High confidence.
- F3 — sizes measured, but "should we change it" is a judgement call.
- F5 — the `skipWaiting`/`clients.claim` pair and the 404 path are read
  directly from `sw.js`. The white-screen consequence is a well-known
  failure mode of this exact combination, but I have **not** reproduced it
  against two real deploys of this app. Treat the mechanism as confirmed
  and the user-visible severity as likely-but-unproven.

---

## 5. Outcomes

| Finding | Status |
|---|---|
| F1 — invisible stat numbers in dark mode | Fixed |
| F2 — light-surface stragglers | Fixed |
| F3 — recharts weight | Flagged only, not actioned (by design) |
| F4 — no vendor chunk | **Not actioned — see below** |
| F5 — service worker update flow | Fixed — reload prompt |
| F6 — Analytics loads behind a bare spinner | Fixed |

Final state: `npm run build` green, `npm run lint` exit 0. Entry chunk
136.26 kB gzip, `Analytics-*.js` 114.55 kB gzip — i.e. unchanged from the
baseline in §1, as expected given F4 was dropped.

### F4 — why it was dropped

The recommendation in §2/§3 assumed the `manualChunks` object form:

```js
manualChunks: { 'react-vendor': ['react', 'react-dom', 'react-router-dom'] }
```

That form is **invalid on this project's toolchain**. `frontend` is on
Vite 8.1.4, which builds with rolldown rather than rollup, and rolldown
accepts only the callback signature. The object form fails the build
outright:

```
Invalid type: Expected Function but received Object.
TypeError: manualChunks is not a function
```

A working function-form equivalent was written and would have needed two
non-obvious details to be correct: matching on `/node_modules/react/`
rather than a substring (a bare `react` match also captures `react-is`,
a recharts dependency, dragging chart code into the eager bundle), and
grouping `scheduler` with react-dom so it isn't stranded in the entry
chunk. Both are the kind of thing that looks fine and quietly regresses
caching.

Decision was to drop vendor chunking entirely and keep `vite.config.js`
at its original 11 lines. The caching benefit described in F4 is real but
unrealised; the finding stands if someone wants to revisit it. If so,
start from the function form, not the object form.

### F5 — how it was fixed

Chosen option: **reload prompt**. A waiting worker raises a toast with a
"Reload now" action instead of taking over silently.

| File | Change |
|---|---|
| `public/sw.js` | `skipWaiting()` removed from `install`; added a `message` listener that calls it on `SKIP_WAITING`. `CACHE_VERSION` is now a `__BUILD_VERSION__` placeholder. |
| `scripts/stamp-sw.mjs` | New. Replaces the placeholder in `dist/sw.js` after `vite build`. |
| `package.json` | `build` is now `vite build && node scripts/stamp-sw.mjs`. |
| `src/lib/registerSW.js` | Detects a waiting worker, exposes `onUpdateReady()` / `applyUpdate()`, reloads once on `controllerchange`. |
| `src/context/ToastContext.jsx` | `show`/`info` accept an optional `{ label, onClick }` action, rendered as a button. |
| `src/components/UpdatePrompt.jsx` | New. Subscribes to `onUpdateReady` and raises the toast. Renders nothing. |

Four things worth knowing, since none are obvious from the diff:

- **The prompt does not auto-reload.** Reloading mid-session discards
  whatever the user had typed into a form. That is the reason this is a
  prompt and not a silent `skipWaiting`.
- **`CACHE_VERSION` had to become dynamic for the prompt to work at all,**
  not just for cache eviction. The browser detects a new worker by
  byte-diffing `sw.js`. With a static `'v1'`, a deploy that changed only
  app code produced no new worker, so nothing would ever have been
  waiting to prompt about. Fixing the stale-shell bug and making the
  feature functional turned out to be the same change.
- **The version is derived from the sorted `dist/assets` filenames,** not
  a timestamp or git SHA. Those change on every build or every commit, so
  either would prompt users to reload for a deploy that shipped identical
  frontend code. Verified: two consecutive builds of unchanged source both
  produced `76128b8f36b2`.
- **First-ever install is deliberately silent.** `registerSW.js` gates the
  prompt on `navigator.serviceWorker.controller` being non-null; on a
  first visit there is no older code running, so there is nothing to
  announce.

Not verified end-to-end: the full two-deploy cycle against a live origin.
The stamping and placeholder substitution are confirmed against real build
output, and the worker/registration logic is standard, but "user sees the
toast on deploy N+1 and reload lands them on the new build" has not been
observed on a deployed environment. Worth a look on the next real deploy.
