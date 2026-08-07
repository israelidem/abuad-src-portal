# API Reference

Base URL: `http://localhost:5000`

Authenticated requests carry the Supabase access token:

```
Authorization: Bearer <access_token>
```

Roles are read from the `profiles` table on every request — never from the client.

---

## Conventions

| Code | Meaning |
|------|---------|
| 400  | Validation failed (`details[]` names the offending fields) |
| 401  | Missing or expired token |
| 403  | Authenticated, but not permitted |
| 404  | Not found — also returned for tickets you aren't allowed to see |
| 409  | Conflict (duplicate slug, etc.) |
| 429  | Rate limited |

A hidden ticket returns **404 rather than 403** on purpose: a 403 would confirm the ticket exists.

---

## Auth — `/api/auth`

| Method | Path | Access | Notes |
|--------|------|--------|-------|
| POST | `/check-email` | Public | Warns about a disallowed domain before the form is filled |
| POST | `/signup` | Public | Enforces the email-domain policy |
| GET | `/me` | Auth | Current profile |
| PATCH | `/me` | Auth | Update own profile |

Login, password reset and refresh run client-side through supabase-js.

---

## Tickets — `/api/tickets`

### `GET /` — list

Public. Anonymous callers see public, unflagged tickets only.

| Param | Values | Default |
|-------|--------|---------|
| `page` | ≥ 1 | 1 |
| `limit` | 1–100 | 20 |
| `status` | `PENDING` `IN_PROGRESS` `RESOLVED` `CLOSED` `REOPENED` | — |
| `category` | `ACADEMIC` `ICT` `INFRASTRUCTURE` `WELFARE` `ADMINISTRATION` `OTHER` | — |
| `urgency` | `LOW` `MEDIUM` `HIGH` | — |
| `departmentId`, `assignedToId` | UUID | — |
| `faculty` | text | — |
| `q` | text — searches description, location, ticket number, faculty | — |
| `scope` | `all` · `mine` (auth) · `assigned` (staff) | `all` |
| `sort` | `newest` `oldest` `most_voted` `most_discussed` `due_soon` `urgency` | `newest` |
| `includePrivate` | staff only | `false` |

`sort` is an allowlist mapped to Prisma `orderBy` server-side — user input never reaches the query builder.

Returns `{ tickets: [...], pagination: {...} }`. The viewer's votes are fetched in one query per page, not per ticket.

### `GET /stats`

Counts by status, category and urgency, plus an overdue total. Declared before `/:id` so `stats` isn't parsed as a ticket ID.

### `POST /` — create

Auth. Rate limited to 15/hour.

```jsonc
{
  "faculty": "Engineering",
  "category": "INFRASTRUCTURE",
  "description": "At least 20 characters.",
  "urgency": "HIGH",
  "locationText": "Block C, 2nd floor",
  "locationLat": 7.61,          // optional
  "locationLng": 5.22,          // optional
  "departmentId": "uuid",       // optional
  "isAnonymous": false,
  "isPublic": true,
  "attachments": [              // optional, max 5
    { "storagePath": "...", "mimeType": "image/jpeg", "sizeBytes": 204800 }
  ]
}
```

Files upload directly to Supabase Storage; only paths are posted here. `ticketNumber` (`SRC-000001`) comes from a Postgres sequence, so concurrent submissions can't collide. `dueAt` is derived from urgency — 24h / 72h / 1 week.

### Other ticket endpoints

| Method | Path | Access | Notes |
|--------|------|--------|-------|
| GET | `/:id` | Public* | Includes `hasVoted` when signed in |
| GET | `/:id/timeline` | Public* | Immutable audit trail |
| PATCH | `/:id` | Author (PENDING only) / Admin | Changing urgency re-derives `dueAt` |
| DELETE | `/:id` | Author (PENDING only) / Admin | Cascades to comments, votes, events |
| PATCH | `/:id/status` | Staff | Validates the transition; optional `note` posts a comment |
| PATCH | `/:id/assign` | Staff | `assignedToId: null` unassigns; students can't be assignees |
| PATCH | `/:id/flag` | Admin | Moderation |
| POST | `/:id/vote` | Auth | Idempotent toggle; can't vote on your own ticket |

\* subject to visibility rules

**Legal status transitions**

```
PENDING     → IN_PROGRESS, RESOLVED, CLOSED
IN_PROGRESS → RESOLVED, CLOSED, PENDING
RESOLVED    → CLOSED, REOPENED
CLOSED      → REOPENED
REOPENED    → IN_PROGRESS, RESOLVED, CLOSED
```

Anything else is a 400. `RESOLVED` sets `resolvedAt`, `CLOSED` sets `closedAt`, `REOPENED` clears both.

---

## Comments — `/api/tickets/:id/comments`

| Method | Path | Access |
|--------|------|--------|
| GET | `/` | Public* — internal notes stripped for non-staff |
| POST | `/` | Auth — blocked on closed tickets |
| PATCH | `/:commentId` | Author only |
| DELETE | `/:commentId` | Author or staff |

`isInternal` is honoured **only** for staff; a student sending `isInternal: true` gets a normal comment. Internal notes are filtered in the query itself, so they never enter the response.

---

## Departments — `/api/departments`

| Method | Path | Access | Notes |
|--------|------|--------|-------|
| GET | `/` | Public | `?includeInactive=true` for admin views |
| POST | `/` | Admin | Slug must be unique, `[a-z0-9-]` |
| PATCH | `/:id` | Admin | |
| DELETE | `/:id` | Admin | Deactivates instead if tickets reference it |

---

## Anonymity

`authorId` is **always** stored, even for anonymous tickets, so an admin can trace abuse through the audit log. Anonymity is therefore an API-layer guarantee, enforced in one place — `serialiseTicket()` in `services/ticketService.js`.

Every response passes through it. For an anonymous ticket:

- `author` is `null` for everyone except the author themselves
- staff additionally receive `hasHiddenAuthor: true` so the UI can label it
- the `CREATED` timeline event has its actor masked

Adding an endpoint that returns raw Prisma rows would bypass this — always serialise.

## Permissions

Every ticket response carries a `permissions` object (`canEdit`, `canDelete`, `canManage`, `canComment`) so the client can render the right controls without duplicating the rules. These are advisory for the UI; the server re-checks on every mutation.

## Rate limits

| Scope | Limit |
|-------|-------|
| All `/api` | 300 / 15 min |
| Auth | 10 / 15 min |
| Ticket creation | 15 / hour |
| Comments and votes | 60 / 5 min |
