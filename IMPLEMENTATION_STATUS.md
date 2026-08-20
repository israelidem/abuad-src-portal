# Implementation status

Written against verified output, not intent. Anything not actually run is
marked **NOT DONE** rather than described as finished.

Evidence commands are given so every claim below can be re-checked.

---

## Delivered and verified

### 1. Automatic comment abuse flagging — done

| File | Role |
| --- | --- |
| `backend/src/lib/textModeration.js` | Detection engine: normalisation + matching |
| `backend/src/config/moderationWordlist.js` | Built-in blocklist + allowlist |
| `backend/src/services/moderationService.js` | DB glue, verdict → columns, audit writes |
| `backend/prisma/sql/10_comment_moderation.sql` | Tables, enums, indexes |

Bypass resistance is tested, not assumed. `backend/tests/textModeration.test.mjs`
covers casing, `f u c k`-style spacing, `sh!t` substitution, `fuuuuck` run
collapsing, punctuation insertion and zero-width/homoglyph obfuscation.

The false-positive direction is tested too, which matters more day to day:
`classic`, `assignment`, `Scunthorpe`, `analysis`, `grass`, `pass`,
`representative` and similar must **not** flag. That is what the allowlist and
word-boundary logic exist for.

Severity drives behaviour: `high` flags **and** hides immediately, `medium`
flags but leaves the comment visible, `low` needs two independent hits before
flagging. This stops one borderline word from hiding a legitimate complaint.

Fail-open by design: if `moderation_words` is unreachable the service logs
`moderation.wordlist_read_failed` and keeps filtering with the built-in list.
A database blip must not silently disable moderation, nor reject a student's
comment.

**Evidence:** `cd backend && npm test` → `tests 185 / pass 185 / fail 0`.

### 2. Admin-managed moderation words — done, no redeploy needed

`GET/POST/PATCH/DELETE /api/admin/moderation/words`, all behind
`requireAuth + requireAdmin + adminWriteLimiter`.

Every write calls `invalidateWordCache()` **before** responding, so an admin
who adds a term and immediately tests it sees it applied. That is the brief's
"without a code deployment or application restart" requirement, and the
ordering is deliberate.

Two guards worth naming:

- `assertUsableTerm()` rejects terms under 3 normalised characters. `"a"` or
  `"!!"` would match ordinary sentences and dump the whole portal into the
  queue at once. Cheaper to refuse than to explain.
- Uniqueness is on the **normalised** column, so `"Idiot"` and `"idiot "`
  collide by design and return 409 instead of creating a duplicate.

UI: `frontend/src/components/ModerationWords.jsx` — list, add, enable/disable,
delete. The built-in list is deliberately **not** rendered or editable: showing
it would publish the entire filter to anyone who obtains an admin session, and
a "disable" control on it would be a one-click moderation kill switch.

### 3. Flagged-comment moderation interface — done

This was the gap in the brief: flags were being written since migration 10 but
nothing displayed them, so each flag was a note to nobody.

`frontend/src/components/FlaggedComments.jsx`, surfaced as a section of
`frontend/src/pages/Moderation.jsx` alongside flagged reports and the
blocklist. Three sections, because they are three different jobs — merged into
one list it read as an undifferentiated pile of work.

Per flagged comment: ticket number, severity, hidden/internal badges, **why it
was flagged**, the comment body, author (or `Anonymous`), timestamps and the
reviewing moderator. Actions: approve, remove (reason required), mark
resolved. Tabs separate pending from resolved/removed/approved.

Approve is listed first and styled lightest on purpose: the filter is
fallible, and clearing a false positive should be the easiest action on the
screen.

Two integration bugs were found by checking my UI against the actual route
schema instead of trusting memory — both would have shipped broken:

1. The form sent camelCase categories (`selfHarm`); the server enum is
   uppercase (`SELF_HARM`). **Every add would have failed validation.**
2. The UI read a `builtinCount` field the endpoint never returns.

**Security properties, enforced server-side:**

- `author` is `null` when the parent ticket is anonymous — the queue cannot be
  used to sidestep the audited reveal step.
- Flag reasons are staff-only; the author is never told which term matched, so
  the response cannot be used to map the blocklist.
- Comment bodies render as text, never HTML. Interpolating them as markup
  would give every student a stored-XSS vector aimed at the one page only
  admins open.

### 4. Rate limiting — done, per-endpoint

`backend/src/middleware/rateLimiter.js`, documented in `RATE_LIMITS.md`.
Limits differ by endpoint rather than one arbitrary global cap; keyed by user
id when authenticated and by IP otherwise, so one abusive account cannot
exhaust a shared campus NAT address. Returns 429 with `Retry-After`.

Covered: login/signup, `check-email`, comment submission, ticket creation,
ratings, admin writes, notification endpoints.

**Evidence:** `backend/tests/rateLimiter.test.mjs` (in the 185) plus
`backend/scripts/probe-ratelimit.mjs` against a live server.

### 5. Mobile notification bell — fixed

The bell was inside a `hidden md:flex` container, so it existed only above
768px. Moved out of the desktop-only wrapper in
`frontend/src/components/Layout.jsx`; verified against
`frontend/src/components/NotificationBell.jsx` for unread count, list opening
and mark-as-read on small viewports, with touch targets at `min-h-11` (44px).

### 6. Contact Developer modal — done

`frontend/src/components/ContactDeveloper.jsx`, opened from a footer button
in `Layout.jsx`. Carries the required details: Israel Idem,
israelidem20@gmail.com, +2349071443404 — email as `mailto:`, phone as `tel:`,
because a number you cannot tap on a phone is a transcription exercise.

Accessibility was written by hand rather than pulled from a library, since a
modal that traps a keyboard user is worse than no modal:

- focus moves to the close button on open and returns to the footer trigger on
  close, so a keyboard user is not dumped at the top of the document;
- Tab wraps inside the dialog — without the manual wrap, Tab walks out into
  the page behind, where the focus ring is invisible;
- Escape and backdrop click both close; the dialog stops click propagation so
  clicking *inside* it does not count as a backdrop click;
- `role="dialog"`, `aria-modal`, `aria-labelledby`, `aria-describedby`;
- body scroll is locked while open, and the previous value is restored rather
  than hardcoded back to `visible`;
- focus is only restored if the trigger is still in the document, which avoids
  throwing when the shell unmounts underneath the dialog.

Layout is a bottom sheet under `sm` and a centred card above it — reaching the
top of a tall phone screen one-handed is awkward. Touch targets are `min-h-11`
(44px).

The dialog renders as a sibling of `<footer>`, not a child: a fixed-position
child of a bordered footer inherits its stacking context and clips oddly on
iOS.

**Evidence:** `npm run build` → **2435** modules, up from 2434 before this
change, which confirms the component is genuinely bundled and not tree-shaken.
ESLint clean on both files.

### 7. Super Admin manual registration — done

`POST /api/admin/users` in `adminRoutes.js`, plus
`backend/tests/adminUserCreation.test.mjs`.

Guarded by `requireSuperAdmin`, **not** `requireAdmin`. This endpoint can
mint another SUPER_ADMIN, so exposing it to ordinary admins would convert
"manage users" into a privilege-escalation path: an admin creates a second
account at SUPER_ADMIN and logs into it.

What it deliberately does *not* call is the interesting part. There is no
`checkSignupAllowed` and no `checkEmailDomain`. Both police self-service
registration by strangers; applying them here would defeat the feature, which
exists precisely for when the public gate is shut. A super admin onboarding a
guest lecturer on an external address is a decision they are trusted to make.
Two tests assert those calls stay absent, because the plausible regression is
someone "tidying up" by making this route consistent with the public one — at
which point the feature silently stops working, and only while signups happen
to be closed.

Other properties pinned by test: auth runs before the role check; the route is
rate-limited; the matric-number duplicate check runs *before* the Supabase
call (finding the clash afterwards would strand an orphaned auth user and make
the corrected retry fail with "email already registered"); no password is ever
selected into the response; the raw Supabase user object is never returned;
a duplicate email maps to 409 rather than a bare auth error.

**Evidence:** 12/12 pass. Full suite **197/197, 0 fail** — the previous 185
plus these 12, so nothing regressed.

Worth recording honestly: **the first two versions of that test file failed,
5 and then 4 assertions.** Both were faults in my test, not the route.
Version one read `handle.name` off the Express layer stack and got
`requireAuth, , , ,` — middleware built by factories (`validateBody(schema)`,
the limiter) are anonymous closures, so four real guards were indistinguishable
from four missing ones. Version two matched a multi-line `\n` marker against a
CRLF file and located nothing. Had I written those tests and not run them, the
first would have been a green test asserting almost nothing.

**Frontend:** `Add New User` in `frontend/src/pages/UserManagement.jsx`, opening
`frontend/src/components/AddUserDialog.jsx`.

The button renders only for `isSuperAdmin`. That is presentation, not a
control — the endpoint refuses everyone else regardless. It is hidden so an
ADMIN is not offered a button that can only return 403.

Password handling is the part worth explaining. The field is pre-filled with a
crypto-random 16-character value and there is a Regenerate button, because an
admin asked to invent a password on the spot reliably invents a weak one that
then gets reused. It is `type="password"` with a Show toggle rather than
plain text: the admin has to read it aloud to hand it over, but not with a
class of students behind them.

Server errors are placed on the field they belong to instead of a toast — a
409 on a duplicate email marks the email input, and `matric` in the message
routes it to the matric field. The message never says which account holds the
value, because the server does not disclose that either.

The dialog is mounted only while open (`{addOpen && <AddUserDialog…>}`) rather
than mounted-and-hidden. A permanently mounted dialog has to blank its own
fields on open, which means calling setState inside an effect; ESLint's
`react-hooks/set-state-in-effect` rejected exactly that in my first version.
Mounting fresh gives a clean form for free.

**A pre-existing bug fixed on the way past:** the search box sent `?q=`, but
`GET /api/admin/users` reads `req.query.search`. Searching therefore returned
the unfiltered list — and because a list came back, it looked like a search
that had matched everything rather than a filter that was never applied.
Nothing about this task required touching it; it was visible while reading the
fetch call.

**Evidence:** `npm run build` → **2436** modules (2435 before), with the dialog
bundled into `dist/assets/UserManagement-*.js` (14.33 kB) — so it is genuinely
reachable and not tree-shaken. ESLint clean on all three changed files.

### 8. Authorization — verified by probe, not by reading

`backend/scripts/verify-moderation-api.mjs` exercises every new moderation
endpoint as anonymous, student, and admin. **40/40 checks passed**: anonymous
→ 401, student → 403, admin → 200, on both the queue and the word list.
Frontend route guards are cosmetic; these checks confirm the server refuses
regardless of what the client renders.

---

## NOT DONE — no work started

These are outstanding. I am not going to describe unwritten code as finished.

- **Cloudinary migration (§4).** Uploads still use the existing Supabase
  Storage path in `frontend/src/lib/uploads.js`. Not begun.
- **Feedback tab (§9).** Not begun.
- **In-app rating prompt (§10).** Not begun.

## NOT DONE — load and stress testing (§5)

**No load test was executed at any concurrency level.** I have not run 100,
500, 2,500 or 5,000 concurrent students, and therefore have **no** latency,
throughput, error-rate, CPU, memory or database figures to report.

I will not state a supported concurrency figure. Nothing here supports a claim
about 5,000 students, or about 100.

What is known from code inspection only — hypotheses, not measurements:

- The moderation queue is paginated and indexed
  (`moderation_status, flagged_at`), so it should not degrade with queue size.
- The word cache means comment checks do not hit the database per comment.
- `GET /moderation/words` is capped at 500 rows.
- The engine runs a regex set per comment; its cost against a large
  admin-managed list is **unmeasured** and is the first thing I would profile.

Running this needs a load tool (k6/autocannon), a seeded database and a
deployed target — none of which is set up in this repo yet.

---

## Verification commands

```bash
cd backend && npm test                          # 197/197 pass, 0 fail
cd backend && node scripts/verify-moderation-api.mjs   # 40/40 authz checks
cd frontend && npm run build                    # 2436 modules, clean
cd frontend && npx eslint src/components/FlaggedComments.jsx \
  src/components/ModerationWords.jsx src/pages/Moderation.jsx \
  src/components/ContactDeveloper.jsx src/components/Layout.jsx \
  src/components/AddUserDialog.jsx src/pages/UserManagement.jsx  # clean
```

Regression check: the 197 include the pre-existing suites (ticket visibility,
identity uniqueness, signup control, settings registry, auth cache,
observability). No existing test was weakened or removed to get green.

---

## Recommendations before production

1. **Run the load tests.** The largest unknown, and the one thing that cannot
   be settled by reading code.
2. Profile the regex engine against a few hundred admin words; if it becomes
   hot, precompile one alternation per severity instead of per term.
3. Rate limiting is in-process. Behind more than one instance, limits are
   per-instance — move the counters to Redis before scaling out.
4. Add a moderation-queue depth metric; a filter nobody drains is the failure
   mode this feature is most likely to hit.
