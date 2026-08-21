-- ============================================================
-- 05 — DEV role, and required student profile fields
--
-- Run this against the database before deploying the matching code.
-- Idempotent: every statement guards itself, so re-running is safe.
--
-- Two unrelated changes share this file because both are small and both
-- must land with the same release:
--
--   1. The DEV role (requirement 7)
--   2. Backfill-safe handling for matric/faculty/department (requirement 6)
-- ============================================================

-- ------------------------------------------------------------
-- 1. DEV role
--
-- `add value if not exists` is the same pattern 04_phase4.sql used for
-- SUPER_ADMIN. It cannot run inside a transaction block on older Postgres,
-- which is why this file is applied as plain SQL rather than through a
-- wrapped migration.
--
-- Ordering matters: enum values sort in declaration order, and
-- adminRoutes lists users with `orderBy: [{ role: 'desc' }]`. Appending
-- DEV after SUPER_ADMIN therefore puts DEV at the top of the user list,
-- which is where the highest-privilege account belongs.
-- ------------------------------------------------------------
alter type "UserRole" add value if not exists 'DEV';

-- ------------------------------------------------------------
-- 2. RLS helper functions
--
-- The API connects with the service_role key and bypasses RLS, so these
-- policies are defence in depth for any direct/anon connection. They were
-- written before DEV existed, so a DEV would have been treated as a
-- student by every policy below — locked out of exactly the data the role
-- is meant to be able to see.
--
-- Guarded with a catalogue check: these functions only exist if
-- 01_post_migration.sql / 04_phase4.sql were applied. A fresh database
-- that skipped them must not fail here.
-- ------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_staff'
  ) then
    execute $fn$
      create or replace function public.is_staff()
      returns boolean
      language sql
      security definer
      stable
      set search_path = public
      as $body$
        select exists (
          select 1 from public.profiles
          where id = auth.uid()
            and role in ('REP', 'ADMIN', 'SUPER_ADMIN', 'DEV')
            and is_active = true
        );
      $body$;
    $fn$;
  end if;

  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_super_admin'
  ) then
    -- DEV counts as a super admin for every *read* policy: it holds all
    -- SUPER_ADMIN permissions. The one-way protection (a SUPER_ADMIN
    -- cannot manage a DEV) is enforced in the API's canManageAccount,
    -- because RLS is bypassed on that path and cannot express it.
    execute $fn$
      create or replace function public.is_super_admin()
      returns boolean
      language sql
      security definer
      stable
      set search_path = public
      as $body$
        select exists (
          select 1 from public.profiles
          where id = auth.uid()
            and role in ('SUPER_ADMIN', 'DEV')
            and is_active = true
        );
      $body$;
    $fn$;
  end if;
end $$;

-- ------------------------------------------------------------
-- 3. Database-level protection for DEV accounts
--
-- The API is the only writer in production, but a trigger closes the gap
-- the API cannot cover: a direct psql session, a Supabase dashboard edit,
-- or a future endpoint that forgets the check.
--
-- The rule is narrow on purpose. It does not stop a DEV row from being
-- changed; it stops the two changes that would strip the protection
-- itself — demotion and deactivation — unless the session is a superuser
-- (i.e. a deliberate operator action, not an application bug).
-- ------------------------------------------------------------
create or replace function public.protect_dev_accounts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only DEV rows are protected.
  if old.role <> 'DEV' then
    return new;
  end if;

  -- A superuser/owner session is the documented escape hatch: the account
  -- has to be recoverable by whoever administers the database, or a lost
  -- DEV login would be unfixable.
  if (select usesuper from pg_user where usename = current_user) then
    return new;
  end if;

  if new.role <> old.role then
    raise exception 'A DEV account cannot be demoted through the application.'
      using errcode = 'insufficient_privilege';
  end if;

  if old.is_active = true and new.is_active = false then
    raise exception 'A DEV account cannot be deactivated through the application.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end $$;

drop trigger if exists trg_protect_dev_accounts on public.profiles;
create trigger trg_protect_dev_accounts
  before update on public.profiles
  for each row
  execute function public.protect_dev_accounts();

-- Deletion is blocked separately: BEFORE DELETE has no `new` row.
create or replace function public.protect_dev_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role = 'DEV'
     and not (select usesuper from pg_user where usename = current_user) then
    raise exception 'A DEV account cannot be deleted through the application.'
      using errcode = 'insufficient_privilege';
  end if;
  return old;
end $$;

drop trigger if exists trg_protect_dev_deletion on public.profiles;
create trigger trg_protect_dev_deletion
  before delete on public.profiles
  for each row
  execute function public.protect_dev_deletion();

-- ------------------------------------------------------------
-- 4. Matric number / faculty / department (requirement 6)
--
-- These stay NULLable at the database level, deliberately.
--
-- The requirement is that *new* registrations must supply all three, and
-- that existing accounts must not break. A NOT NULL constraint would do
-- the opposite: every student who registered before this release has
-- NULLs here, and adding NOT NULL would either fail outright or force us
-- to invent placeholder data for real people.
--
-- So the rule lives in the signup validator (authSchemas.js), which is
-- the only path that creates a profile. What the database contributes is
-- the uniqueness guarantee on matric_number, which the API cannot make
-- race-safe on its own.
--
-- The partial unique index below already exists as `profiles_matric_
-- number_key` from the Prisma schema (@unique). It is asserted here only
-- so this file documents the full picture; `if not exists` makes it a
-- no-op on any database where Prisma already created it.
-- ------------------------------------------------------------
create unique index if not exists profiles_matric_number_key
  on public.profiles (matric_number)
  where matric_number is not null;

-- A trailing-space or case-variant matric number is the same number. The
-- API normalises before insert; this makes the guarantee independent of
-- which code path did the writing.
create unique index if not exists profiles_matric_number_normalised_key
  on public.profiles (upper(btrim(matric_number)))
  where matric_number is not null;

-- ------------------------------------------------------------
-- 5. Verification
--
--   select unnest(enum_range(null::"UserRole"));
--     -> STUDENT, REP, ADMIN, SUPER_ADMIN, DEV
--
--   -- should raise insufficient_privilege (as a non-superuser role):
--   update profiles set is_active = false where role = 'DEV';
--
--   -- promote the maintainer account:
--   update profiles set role = 'DEV' where email = 'you@abuad.edu.ng';
-- ------------------------------------------------------------
