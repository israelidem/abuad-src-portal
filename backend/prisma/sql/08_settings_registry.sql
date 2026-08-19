-- ============================================================
-- Phase 6 — additional portal settings
--
-- Adds five columns to the app_settings singleton. Every one of them is
-- actually enforced somewhere; see `enforcedBy` in
-- backend/src/config/settingsRegistry.js.
--
--   portal_name                 general    login screen + document title
--   support_email               general    shown when registration is closed
--   require_matric_number       reg        enforced in authRoutes signup
--   allow_anonymous_tickets     tickets    enforced in ticketRoutes create
--   max_attachments_per_ticket  tickets    enforced in ticketRoutes create
--
-- NOT DESTRUCTIVE. Additive only: no drops, no type changes, no data
-- rewrites. Existing rows keep working because every column has a default,
-- so the singleton row is backfilled in place.
--
-- Safe to run more than once (ADD COLUMN IF NOT EXISTS throughout).
--
-- ------------------------------------------------------------
-- HOW TO RUN THIS — read before pasting into the SQL editor
-- ------------------------------------------------------------
-- The Supabase SQL editor wraps a pasted script in ONE implicit
-- transaction. That is how migration 07 failed: a later statement raised
-- an error and rolled back the ALTERs that had already succeeded, leaving
-- the schema unchanged while the editor showed a single red message.
--
-- Prefer the runner, which sends each statement separately so one failure
-- cannot undo the rest:
--
--   node backend/scripts/apply-sql.mjs prisma/sql/08_settings_registry.sql
--
-- Then confirm, rather than assuming:
--
--   node backend/scripts/inspect-settings.mjs
--
-- Finally regenerate the Prisma client, or every settings read will select
-- columns the client does not know about:
--
--   npx prisma generate        (stop the dev server first — it holds the
--                               query-engine DLL open on Windows)
-- ============================================================

-- --- General -------------------------------------------------
-- Defaults chosen so the portal looks unchanged after this runs: the name
-- matches what the UI currently hard-codes.
alter table public.app_settings
  add column if not exists portal_name text not null default 'ABUAD SRC Portal';

-- Nullable: null means "we have not set a support address", which the UI
-- renders as no contact line rather than an empty mailto link.
alter table public.app_settings
  add column if not exists support_email text;

-- --- Registration --------------------------------------------
-- Defaults to false to preserve today's behaviour, where matric number is
-- optional at signup. Turning this on is an explicit admin decision.
--
-- Also the fail-open choice: if settings cannot be read, registration must
-- not start rejecting students for a missing field.
alter table public.app_settings
  add column if not exists require_matric_number boolean not null default false;

-- --- Tickets -------------------------------------------------
-- Anonymous feedback is a core feature of the portal, so it defaults on.
-- Turning it off affects NEW submissions only — tickets already submitted
-- anonymously stay anonymous, because retroactively revealing an author
-- would break the promise under which they were filed.
alter table public.app_settings
  add column if not exists allow_anonymous_tickets boolean not null default true;

-- 5 matches the limit the frontend picker already applies, so this
-- codifies current behaviour rather than changing it.
alter table public.app_settings
  add column if not exists max_attachments_per_ticket integer not null default 5;

-- A limit of zero would silently disable attachments with no explanation
-- anywhere in the UI; the ceiling keeps a typo from becoming an upload
-- flood. Mirrored in Zod, but enforced here too — the database is the
-- boundary that a direct connection cannot bypass.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'app_settings_max_attachments_range'
  ) then
    alter table public.app_settings
      add constraint app_settings_max_attachments_range
      check (max_attachments_per_ticket between 1 and 10);
  end if;
end $$;

-- ------------------------------------------------------------
-- Verify — reports rather than assumes
-- ------------------------------------------------------------
-- Deliberately a NOTICE, not an exception: raising here would abort the
-- transaction in the SQL editor and roll back the very columns just added,
-- which is the trap that broke 07.
do $$
declare
  missing text[];
begin
  select array_agg(expected)
    into missing
  from unnest(array[
    'portal_name',
    'support_email',
    'require_matric_number',
    'allow_anonymous_tickets',
    'max_attachments_per_ticket'
  ]) as expected
  where not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'app_settings'
      and column_name = expected
  );

  if missing is null then
    raise notice 'OK — all five settings columns present.';
  else
    raise notice 'MISSING: %', array_to_string(missing, ', ');
    raise notice 'Re-run with backend/scripts/apply-sql.mjs to see which statement failed.';
  end if;
end $$;
