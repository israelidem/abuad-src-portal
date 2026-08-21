# Storage Migration — Supabase Storage → Cloudinary

Task §4. Covers what changed, what deployers must do, and what happens to
images uploaded before the switch.

## Architecture

Uploads are **direct-to-Cloudinary with a server-signed authorisation**.
Image bytes never pass through the API.

```
browser                         API                     Cloudinary
   |  POST /api/uploads/signature |                          |
   |----------------------------->|  (auth + rate limit)     |
   |   {signature, folder, ...}   |                          |
   |<-----------------------------|                          |
   |                                                         |
   |  POST /image/upload  (file + signed fields)             |
   |-------------------------------------------------------->|
   |   {public_id, bytes}                                    |
   |<--------------------------------------------------------|
   |                              |                          |
   |  POST /api/tickets  {storagePath: public_id}            |
   |----------------------------->|                          |
```

### Why not proxy through the API

The portal runs on one small Render instance. Proxying a 5 MB upload
occupies a Node worker for the whole transfer; on a slow mobile connection
that is tens of seconds. Thirty concurrent uploads would consume the event
loop that every other request shares — the same reason the original base64
implementation was replaced. Direct upload keeps the API's involvement to
one small JSON response.

### Why signed rather than an unsigned preset

An unsigned preset is a public write endpoint: anyone who reads the bundle
can upload to the account until quota is exhausted. Signed uploads require
an authenticated call to obtain a short-lived signature, so uploads are
attributable and rate-limited.

## Enforcement

Limits are in the **signature**, not just in JavaScript. Cloudinary
recomputes the signature over the fields it receives and rejects the upload
if any signed value was altered, so editing the request in devtools does not
widen the limits.

| Constraint | Value | Enforced by |
|---|---|---|
| Formats | jpg, jpeg, png, webp, heic | signed `allowed_formats` |
| Max size | 5 MB | signed `max_bytes` |
| Folder | server-chosen | signed `folder` |
| Metadata | stripped | signed `fl_strip_profile` |
| Dimensions | capped 2000×2000 | signed transformation |

`fl_strip_profile` removes EXIF, which carries **GPS coordinates** on phone
photos. Attachments are often photos taken on campus, and delivery URLs are
public, so leaving that in would publish where a student was standing.

## Anonymity

Anonymous tickets exist so students can report issues without exposing
their identity. Delivery URLs are public and guessable-adjacent, so the
storage path must not identify the uploader.

| Mode | Folder |
|---|---|
| Identified | `abuad-src-portal/tickets/u/<userId>/<uuid>` |
| Anonymous | `abuad-src-portal/tickets/anon/<random-uuid>/<uuid>` |

Each anonymous upload gets a **fresh** random folder, so two attachments on
different anonymous tickets cannot be correlated by path. Tested in
`cloudinary.test.mjs` — "never puts the user id in an anonymous upload path"
and "gives every anonymous upload a distinct folder".

## Environment variables

Backend (server-only — the secret must never reach the bundle):

```
CLOUDINARY_CLOUD_NAME=your-cloud
CLOUDINARY_API_KEY=123456789012345
CLOUDINARY_API_SECRET=...            # server only
CLOUDINARY_FOLDER=abuad-src-portal   # optional
```

Frontend (`VITE_`-prefixed values are compiled into the bundle and public):

```
VITE_CLOUDINARY_CLOUD_NAME=your-cloud
```

The cloud name is not a secret; it appears in every delivery URL and cannot
authorise an upload by itself. **No API key or secret is referenced in any
frontend file.**

### Graceful degradation

All three backend variables are optional in `env.js`. Unconfigured, the app
boots normally and `POST /api/uploads/signature` returns **503** with
"uploads temporarily unavailable"; the frontend surfaces that as "you can
submit without a photo". Ticket submission itself keeps working. A missing
integration should not take the portal down.

## Existing files — no migration required

`ticket_attachments.storage_path` holds Supabase paths for pre-existing
rows. **These are not being moved.** `getAttachmentUrl()` detects the old
format and serves it from Supabase:

```js
const isLegacySupabasePath = (path) => /\.(jpe?g|png|webp|heic|heif)$/i.test(path);
```

Old Supabase paths end in a file extension; new Cloudinary public_ids are
bare UUIDs under a folder. The two are unambiguous.

Consequences:

- Old tickets keep rendering; no downtime, no backfill script, no risk of a
  half-migrated table.
- `VITE_SUPABASE_URL` and the `ticket-attachments` bucket **must be kept**
  for as long as those rows exist. Deleting the bucket breaks images on
  historical tickets.
- If the bucket is ever retired, copy the objects to Cloudinary and update
  `storage_path` per row in the same transaction. Not needed now, and not
  worth the risk for images on closed tickets.

## Deletion and orphans

`DELETE /api/uploads/:publicId` — for cleanup when an upload succeeded but
the ticket submission failed.

Guards, because deletion needs the API secret and so must be proxied:

1. **Path must be under the deployment folder** — otherwise a caller could
   reach other content in a shared Cloudinary account.
2. **Ownership** — the path contains the caller's user id, or is an
   anonymous path (two unguessable UUIDs treated as proof of possession;
   recording an owner would defeat the anonymity it protects).
3. **Not attached** — refuses with 409 if a `ticket_attachments` row
   references it. Without this, a student could delete photographic evidence
   from a complaint after staff had read it.

Failures return 403 with no detail, so the endpoint cannot be used to test
whether a public_id exists.

Remaining orphan sources, both bounded and low-cost:

- Browser closed between upload and submit. Logged as
  `upload.signature_issued` with no matching attachment.
- `deleteImage` failing at Cloudinary. Logged as `upload.deleted` with
  `deleted: false`.

A periodic sweep comparing Cloudinary's list against `storage_path` values
would close these. Not implemented — see REMAINING_WORK.md.

## Verification

`backend/tests/cloudinary.test.mjs` — **20 passed, 0 failed**. Full suite
**220 passed, 0 failed** (baseline was 200).

The signature test computes an expected SHA-1 independently rather than
calling the implementation, so a change in signing logic fails the test
instead of being ratified by it.

Notable cases covered:

- signature matches a hand-computed digest; empty values omitted (mismatched
  handling here causes an opaque 401 from Cloudinary)
- key order does not change the signature
- anonymous paths contain no user id; each is distinct
- API secret absent from the client payload
- folder guard rejects another user's folder, `..` traversal, nested paths,
  and the **prefix-collision** case (`u/user-11` vs `u/user-1`)

Router load verified — both routes register:

```
POST   /signature
DELETE /:publicId(*)
```

### Not verified

No upload has been performed against a real Cloudinary account; no
credentials were available in this environment. The signature algorithm is
tested against Cloudinary's documented scheme, but **the first real upload
in staging is still the proof**. If it returns 401, the cause is signed-field
handling in `uploadAttachment` — the fields sent must exactly match those
signed.
