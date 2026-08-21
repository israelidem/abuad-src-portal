# Implementation Status

Progress against the 16-part task. Written to be checkable: every "done"
claim names the file and the evidence.

**Test suite: 220 passed, 0 failed** (`node backend/scripts/run-tests.mjs`).
Baseline before this work was 200.

## Done and verified

### §1 Automatic comment abuse flagging
- `backend/src/lib/textModeration.js` — normalisation (Unicode confusables,
  leet substitution, repeat collapsing, separator stripping) then
  boundary-anchored matching.
- `backend/src/config/moderationWordlist.js` — built-in list.
- `backend/src/services/moderationService.js` — DB-backed admin terms merged
  with built-ins, cached with TTL so new terms apply without redeploy.
- **Evidence:** `textModeration.test.mjs`, `moderationService.test.mjs`.
  False-positive corpus ("Scunthorpe", "classic", "assignment", "grape")
  asserted clean. Obfuscations (`f u c k`, `f-u-c-k`, `fuuuck`, `fµck`)
  asserted flagged. See `MODERATION_REPORT.md`.
- Pattern warm-up at boot (`server.js`), measured 4782ms → 163ms on first
  comment (`scripts/verify-warmup.mjs`).

### §2 Flagged-comment moderation interface
- `frontend/src/components/FlaggedComments.jsx` — pending/resolved split,
  flag reason, approve/reject/resolve.
- `frontend/src/components/ModerationWords.jsx` — term CRUD + enable/disable.
- Backend authorisation on every moderation route, not just the UI.
- **Evidence:** `scripts/verify-moderation-api.mjs` — a student token gets
  403 on each moderation endpoint.

### §3 Rate limiting
- `backend/src/middleware/rateLimiter.js` — per-endpoint buckets (auth,
  email check, ticket create, comment, interaction, notification, upload,
  feedback, admin write) keyed by user id when known, else IP.
- **Evidence:** `rateLimiter.test.mjs`; `scripts/probe-ratelimit.mjs` drives
  a live server past each limit and confirms 429 + `Retry-After`. Limits and
  reasoning in `RATE_LIMITS.md`.

### §4 Cloudinary storage
- `backend/src/services/cloudinaryService.js`, `routes/uploadRoutes.js`,
  `frontend/src/lib/uploads.js`.
- Signed direct-to-CDN upload; format/size/folder/EXIF-strip all signed, so
  the limits are not bypassable from devtools. Ownership-checked delete that
  refuses images already attached to a ticket. Legacy Supabase paths still
  served, so no backfill.
- **Evidence:** `cloudinary.test.mjs` (20 tests) — signature checked against
  an independently computed SHA-1, IDOR folder guard including the
  prefix-collision case, and an assertion that the API secret never appears
  in the client payload. Details in `STORAGE_MIGRATION.md`.
- **Not verified:** no upload against a real Cloudinary account (no
  credentials in this environment). First staging upload is the proof.

### §6 Super Admin manual user registration
- `AddUserDialog.jsx` + `UserManagement.jsx`; `POST /api/admin/users`.
- Works while public signup is disabled — the closed-signup gate is
  deliberately not on this path.
- **Evidence:** `adminUserCreation.test.mjs` — role restricted to
  SUPER_ADMIN, duplicate email/matric rejected, password hashed not stored,
  succeeds with public registration off, admin cannot self-escalate.

### §7 Mobile notification bell
- `NotificationBell.jsx` + `Layout.jsx`. Bell moved out of the desktop-only
  container into the persistent mobile header.
- Polling replaced with fetch-on-open plus refetch on window focus, removing
  a fixed interval per session.

### §8 Contact Developer
- `ContactDeveloper.jsx` in the footer. Focus trap, Escape to close, focus
  restored to the trigger, `aria-modal`, `tel:`/`mailto:` links.

## Not done

### §9 Feedback tab
Not started. Needs: schema + migration, `feedbackRoutes.js` (the
`feedbackLimiter` bucket is already in place), user-facing form, admin review
UI with New / In Review / Resolved / Closed.

### §10 In-app rating prompt
Not started. Needs: schema, API, delayed 1–5 star modal with dismissal
memory, admin ratings view.

### §5 Load/stress testing (100 / 500 / 2,500 / 5,000)
**Not run.** Requires a seeded database and a load tool against a running
server. No performance claim is made at any concurrency level.

Two findings from work already done are relevant and measured:
- Moderation regex compilation was 4.8s on first comment; warm-up fixed it
  (29x, verified).
- Notification polling per session was removed.

Neither substitutes for a load test.

## Honest caveats

- Frontend work (§2, §6, §7, §8) is verified by code review and backend
  authorisation tests, **not** by browser or device testing. No screenshots,
  no real-viewport checks.
- §11 security review and §12 DB/API review are partially covered: authz
  tested, rate limits probed, XSS avoided via React escaping, indexes added
  in `10_comment_moderation.sql`. No systematic audit of every endpoint.
- §13 accessibility: implemented against WCAG patterns (labels, focus
  states, keyboard paths) but not screen-reader tested.
