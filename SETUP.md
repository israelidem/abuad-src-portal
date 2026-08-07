# Setup

Getting from a fresh clone to a running app. Steps 1–3 happen in the
Supabase SQL Editor; the rest are local.

## Why not `prisma migrate dev`?

Supabase's connection pooler doesn't allow creating the temporary **shadow database** that `prisma migrate dev` requires — the command just hangs. So we generate the SQL locally and apply it through the Supabase SQL Editor instead. Same result, and it's the approach Supabase recommends.

---

## Step 1 — Create the tables

1. Open your project → **SQL Editor** → **New query**
2. Open `backend/prisma/sql/00_schema.sql`, copy everything, paste it in
3. Click **Run**

Creates 7 enums, 17 tables, indexes, and foreign keys.

## Step 2 — Add triggers, RLS, and seed data

1. **New query** again
2. Open `backend/prisma/sql/01_post_migration.sql`, copy everything, paste it in
3. Click **Run**

This adds:
- Ticket number sequence (`SRC-000001`, …)
- Email-domain enforcement trigger
- Auto-create profile on signup
- Comment/vote counter sync
- Row Level Security policies on every table
- Department seed data

**Run them in order.** Step 2 depends on the tables from step 1.

## Step 3 — Create the attachments bucket

1. **New query** again
2. Open `backend/prisma/sql/02_storage.sql`, copy everything, paste it in
3. Click **Run**

Creates the `ticket-attachments` bucket and its access policies. The
final `select` prints a confirmation row — you want `public = true` and
`policies_installed = 4`.

Without this, photo uploads fail with a "bucket not found" error.

## Step 4 — Verify the tables

```bash
cd backend
npm run check:db
```

Probes all 16 tables over the REST API and reports row counts. You want `16/16 tables present`, with `departments` at 6 rows and `app_settings` at 1 — those two confirm step 2's seed data landed.

## Step 5 — Environment files

`backend/.env` and `frontend/.env` are both gitignored. Copy each
`.example` alongside it and fill in the values:

```bash
copy backend\.env.example backend\.env
copy frontend\.env.example frontend\.env
```

The frontend needs only three values, all from **Settings → API**:
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_API_URL`
(`http://localhost:5000` locally).

Use the **anon** key in the frontend — it ships to the browser. The
service-role key belongs in `backend/.env` and nowhere else.

## Step 6 — Auth redirect URLs

**Authentication → URL Configuration**

- Site URL: `http://localhost:5173`
- Redirect URLs: add `http://localhost:5173/reset-password`

Password-reset emails link back here. If it's unset, the link lands on
the wrong page and the recovery token is discarded.

## Step 7 — Start both servers

Two terminals, from the project root:

```bash
npm run dev:api    # Express on :5000
npm run dev:web    # Vite on :5173
```

Check http://localhost:5000/health — you want `{"status":"ok","db":"connected"}`.
Then open http://localhost:5173.

---

## Making yourself an admin

After signing up through the app:

**Table Editor** → `profiles` → find your row → change `role` from `STUDENT` to `ADMIN`.

Or via SQL:

```sql
update profiles set role = 'ADMIN' where email = 'your-email@abuad.edu.ng';
```

---

## Signup domain restriction

Right now **any email can sign up** — convenient while testing.

Before launch, lock it to ABUAD addresses:

```sql
update app_settings set value = 'true' where key = 'restrict_signup_domains';
```

A Postgres trigger enforces this at the database level, so it can't be bypassed by calling the API directly.

---

## Troubleshooting

**`P1001: Can't reach database server`**
Free-tier projects pause after inactivity. Open the dashboard to wake it, wait ~30 seconds, retry.

**`password authentication failed`**
Reset it under **Settings → Database → Reset database password**, then update both `DATABASE_URL` and `DIRECT_URL` in `backend/.env`. If the password contains `@ # $ % / : ?`, percent-encode it — or just use letters and numbers.

Note the database password is a **separate credential** from your Supabase account login.

**`Can't reach database server at ...:6543`**
The pooled connection string needs query parameters Supabase's UI doesn't always include:

```
?pgbouncer=true&connection_limit=1&connect_timeout=30&sslmode=require
```

`pgbouncer=true` tells Prisma to disable prepared statements, which the transaction pooler doesn't support. Without it you get a connection error that looks like a network problem.

**`Missing required env variable: SUPABASE_URL`** (when the value is clearly set)
`.env` is loaded relative to the backend folder by `src/config/env.js`, so this should no longer happen. If it does, confirm the file is at `backend/.env` and not the project root.

**`relation "profiles" does not exist`**
Step 1 didn't complete. Re-run `00_schema.sql`.

---

## Regenerating the schema SQL

If you change `schema.prisma`:

```bash
cd backend
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/sql/00_schema.sql
npx prisma generate
```

Note this generates SQL for a **fresh** database. For incremental changes to a database with existing data, diff against the live schema with `--from-url` instead.
