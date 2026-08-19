-- ============================================================
-- Phase 5 — Registration / signup control
--
-- Run in the Supabase SQL Editor, or:
--   psql "$DIRECT_URL" -f prisma/sql/07_signup_control.sql
--
-- Every statement is idempotent — safe to run more than once.
--
-- WHAT THIS ADDS
--
--   allow_student_signups  Master switch for new student registration.
--                          Defaults to TRUE so applying this migration
--                          changes nothing until an admin flips it.
--
--   signup_closed_message  Optional custom copy shown on the registration
--                          page when signups are off. NULL falls back to
--                          wording supplied by the API.
--
-- WHY ADDITIVE ONLY
--
--   Both columns are nullable-or-defaulted, so this is non-destructive:
--   no data is rewritten, no column is dropped, and the existing single
--   settings row picks up the defaults automatically. Rolling back is a
--   DROP COLUMN, but there is no need to — leaving the switch TRUE is
--   identical to the pre-migration behaviour.
--
-- ENFORCEMENT NOTE
--
--   This flag is read by the Express signup route, which is the only path
--   that can create an account: the browser never holds the service-role
--   key, and `anon` has no INSERT privilege on profiles (revoked in
--   06_security_hardening.sql). So the toggle cannot be bypassed by
--   talking to PostgREST directly — there is no client-side signup path
--   to bypass it with.
--
--   app_settings itself is SUPER_ADMIN-only via RLS (also 06), so a
--   student cannot read or flip this switch through PostgREST either.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Columns
-- ------------------------------------------------------------

alter table public.app_settings
  add column if not exists allow_student_signups boolean not null default true;

alter table public.app_settings
  add column if not exists signup_closed_message text;

comment on column public.app_settings.allow_student_signups is
  'When false, POST /api/auth/signup rejects new student registration with 403. Existing accounts and login are unaffected.';

comment on column public.app_settings.signup_closed_message is
  'Optional admin-authored message shown on the registration page while signups are closed. NULL uses the API default.';


-- ------------------------------------------------------------
-- 2. Backfill, then guarantee NOT NULL
--
-- `add column ... default` populates existing rows, so the update below
-- is belt-and-braces: `add column if not exists` is a no-op when the
-- column already exists, and will NOT retrofit a NOT NULL that a partial
-- earlier run left off. Backfilling and then asserting the constraint
-- makes the end state identical no matter what ran before.
-- ------------------------------------------------------------

update public.app_settings
  set allow_student_signups = true
  where allow_student_signups is null;

alter table public.app_settings
  alter column allow_student_signups set not null;

alter table public.app_settings
  alter column allow_student_signups set default true;


-- ------------------------------------------------------------
-- 3. Give updated_at a database default
--
-- Prisma applies `@updatedAt` in the client, so this column was created
-- NOT NULL with no DB-level default. That is invisible until something
-- inserts without Prisma — a seed like the one below, or any future
-- migration — which then fails with:
--
--   23502: null value in column "updated_at" violates not-null constraint
--
-- Note that `on conflict do nothing` does NOT protect against this:
-- Postgres constructs and constraint-checks the row BEFORE it looks for
-- a unique conflict, so the insert fails even when id = 1 already exists.
--
-- The default is inert for Prisma (which always sends a value) and closes
-- the trap for raw SQL.
-- ------------------------------------------------------------

alter table public.app_settings
  alter column updated_at set default now();


-- ------------------------------------------------------------
-- 4. Ensure the singleton row exists
--
-- getSettings() upserts id = 1 on first read and 01_post_migration.sql
-- already seeds it, so this is a safety net for a fresh database. With
-- the default above, naming updated_at is no longer strictly required —
-- it is passed explicitly anyway so this statement stands alone if the
-- step above is ever reordered or removed.
-- ------------------------------------------------------------

insert into public.app_settings (id, updated_at)
  values (1, now())
  on conflict (id) do nothing;


-- ============================================================
-- VERIFICATION — read-only, safe to re-run
-- ============================================================

-- 1. Both columns exist with the expected defaults.
--
--    EXPECTED: allow_student_signups | boolean | true
--              signup_closed_message | text    | (null)
select column_name, data_type, column_default, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'app_settings'
  and column_name in ('allow_student_signups', 'signup_closed_message')
order by column_name;

-- 2. The live setting. EXPECTED: exactly one row, allow_student_signups
--    = t (signups open) until an admin turns it off from the settings
--    screen. Zero rows here means the seed never landed.
select id, allow_student_signups, signup_closed_message, maintenance_mode
from public.app_settings
where id = 1;

-- 2b. updated_at now has a default, so future raw-SQL inserts won't
--     trip the NOT NULL constraint.
--
--     EXPECTED: now()
select column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'app_settings'
  and column_name = 'updated_at';

-- 3. app_settings is still locked to super admins, so students can
--    neither read nor flip the switch through PostgREST.
--
--    EXPECTED: one row — app_settings_super_admin, cmd = ALL
--
--    Note: the view pg_policies calls this column `policyname`. The
--    catalog table pg_policy calls it `polname`; querying the view with
--    the catalog's name fails with 42703.
select policyname, cmd
from pg_policies
where schemaname = 'public' and tablename = 'app_settings';

-- 4. Confirm anon/authenticated cannot INSERT into profiles, which is
--    what makes the API the only account-creation path.
--
--    EXPECTED: zero rows.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'profiles'
  and privilege_type = 'INSERT'
  and grantee in ('anon', 'authenticated');
