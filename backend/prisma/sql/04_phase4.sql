-- ============================================================
-- Phase 4 — super admin, maintenance mode, ratings, analytics
--
-- Idempotent: safe to run more than once. Paste into the Supabase
-- SQL Editor and run, then deploy so Prisma's client matches.
-- ============================================================

-- ------------------------------------------------------------
-- 1. SUPER_ADMIN role
--
-- Postgres cannot add an enum value inside a transaction block that
-- later uses it, so this runs on its own before anything references it.
-- ------------------------------------------------------------
alter type "UserRole" add value if not exists 'SUPER_ADMIN';

-- ------------------------------------------------------------
-- 2. Maintenance mode columns
-- ------------------------------------------------------------
alter table public.app_settings
  add column if not exists maintenance_mode    boolean not null default false,
  add column if not exists maintenance_message text;

-- ------------------------------------------------------------
-- 3. Teach is_staff() about SUPER_ADMIN
--
-- This function backs most RLS policies. It was written before
-- SUPER_ADMIN existed, so without this patch the highest-privilege role
-- would be treated as a student by every policy that calls it —
-- silently losing access rather than erroring.
-- ------------------------------------------------------------
create or replace function public.is_staff()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('REP', 'ADMIN', 'SUPER_ADMIN')
      and is_active = true
  );
$$;

-- Convenience predicate for policies that must be super-admin only.
create or replace function public.is_super_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role = 'SUPER_ADMIN'
      and is_active = true
  );
$$;

-- ------------------------------------------------------------
-- 4. Ratings: enforce the 1..5 range the schema comment promises
--
-- Prisma can't express CHECK constraints, so `score Int` would happily
-- accept 0 or 99 without this.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ticket_ratings_score_range'
  ) then
    alter table public.ticket_ratings
      add constraint ticket_ratings_score_range check (score between 1 and 5);
  end if;
end $$;

-- Only the reporter may rate, and only once (ticket_id is already unique).
drop policy if exists ticket_ratings_own on public.ticket_ratings;
create policy ticket_ratings_own on public.ticket_ratings
  for all using (user_id = auth.uid() or public.is_staff())
  with check (user_id = auth.uid());

-- ------------------------------------------------------------
-- 5. Polls and announcements: writes are staff-only
--
-- The existing policies granted SELECT but never constrained writes, so
-- a client with the anon key could have inserted its own poll options.
-- ------------------------------------------------------------
drop policy if exists announcements_write on public.announcements;
create policy announcements_write on public.announcements
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists polls_write on public.polls;
create policy polls_write on public.polls
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists poll_options_write on public.poll_options;
create policy poll_options_write on public.poll_options
  for all using (public.is_staff()) with check (public.is_staff());

-- Settings are super-admin only, even for reads: the domain allow/block
-- lists and the maintenance banner are not student-facing.
drop policy if exists app_settings_super_admin on public.app_settings;
create policy app_settings_super_admin on public.app_settings
  for all using (public.is_super_admin()) with check (public.is_super_admin());

-- ------------------------------------------------------------
-- 6. Keep poll_options.vote_count honest
--
-- Same denormalisation pattern the ticket counters use: a trigger, not
-- application code, so a crashed request can't leave a stale count.
-- ------------------------------------------------------------
create or replace function public.sync_poll_option_votes()
returns trigger
language plpgsql
as $$
begin
  if (tg_op = 'INSERT') then
    update public.poll_options set vote_count = vote_count + 1
      where id = new.option_id;
  elsif (tg_op = 'DELETE') then
    update public.poll_options set vote_count = greatest(0, vote_count - 1)
      where id = old.option_id;
  elsif (tg_op = 'UPDATE' and new.option_id <> old.option_id) then
    -- Vote changed to a different option: move the count across.
    update public.poll_options set vote_count = greatest(0, vote_count - 1)
      where id = old.option_id;
    update public.poll_options set vote_count = vote_count + 1
      where id = new.option_id;
  end if;
  return null;
end $$;

drop trigger if exists poll_votes_sync on public.poll_votes;
create trigger poll_votes_sync
  after insert or update or delete on public.poll_votes
  for each row execute function public.sync_poll_option_votes();

-- ------------------------------------------------------------
-- 7. Indexes for the analytics queries
--
-- The admin dashboard groups by status/category over a date range, and
-- resolution time reads resolved_at. Without these it's a full scan on
-- every dashboard load.
-- ------------------------------------------------------------
create index if not exists tickets_created_status_idx
  on public.tickets (created_at, status);

create index if not exists tickets_resolved_at_idx
  on public.tickets (resolved_at) where resolved_at is not null;

create index if not exists tickets_ticket_number_lower_idx
  on public.tickets (lower(ticket_number));

-- ------------------------------------------------------------
-- 8. Promote your account to SUPER_ADMIN
--
-- Replace the address, then run. Nothing else in this file grants the
-- role, and the API refuses to create the first one for you — that has
-- to be a deliberate act by someone with database access.
-- ------------------------------------------------------------
-- update public.profiles set role = 'SUPER_ADMIN'
--  where email = 'you@abuad.edu.ng';

-- Verify:
-- select email, role from public.profiles where role = 'SUPER_ADMIN';
