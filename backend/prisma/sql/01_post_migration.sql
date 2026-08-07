-- ============================================================
-- ABUAD SRC Portal — Post-migration SQL
--
-- Run this AFTER `npx prisma migrate dev` (or `migrate deploy`).
-- Paste into the Supabase SQL Editor, or:
--   psql "$DIRECT_URL" -f prisma/sql/01_post_migration.sql
--
-- Everything here is idempotent — safe to run more than once.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Link profiles -> auth.users
--    Prisma cannot manage the `auth` schema, so the FK is added here.
--    Deleting an auth user now cascades to their profile.
-- ------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_id_fkey_auth_users'
  ) then
    alter table public.profiles
      add constraint profiles_id_fkey_auth_users
      foreign key (id) references auth.users(id) on delete cascade;
  end if;
end $$;


-- ------------------------------------------------------------
-- 2. Constraints Prisma can't express
-- ------------------------------------------------------------

-- app_settings is a single-row table: pin it to id = 1
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_settings_singleton') then
    alter table public.app_settings
      add constraint app_settings_singleton check (id = 1);
  end if;
end $$;

-- Satisfaction rating must be 1..5
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ticket_ratings_score_range') then
    alter table public.ticket_ratings
      add constraint ticket_ratings_score_range check (score between 1 and 5);
  end if;
end $$;

-- Seed the settings row.
-- Development default: unrestricted signup (any valid email).
-- At launch, flip `restrict_signup_domains` from the admin UI.
insert into public.app_settings (id, restrict_signup_domains, allowed_domains, allow_subdomains, blocked_domains, updated_at)
values (1, false, array['abuad.edu.ng'], true, array[]::text[], now())
on conflict (id) do nothing;


-- ------------------------------------------------------------
-- 3. Ticket numbers from a sequence
--    Replaces the old random 6-digit generator, which could collide
--    against the unique index and throw a 500.
-- ------------------------------------------------------------

create sequence if not exists public.ticket_number_seq start 1;

create or replace function public.next_ticket_number()
returns text
language sql
volatile
as $$
  select 'SRC-' || lpad(nextval('public.ticket_number_seq')::text, 6, '0');
$$;

-- Attach it as the column default. Without this the function exists but
-- nothing calls it, so every insert that omits ticket_number fails on the
-- NOT NULL constraint. Prisma maps this to `dbgenerated()` in schema.prisma.
alter table public.tickets
  alter column ticket_number set default public.next_ticket_number();

-- Backfill any rows that predate the default (column is NOT NULL, so an
-- empty string is the only shape this can take).
update public.tickets
   set ticket_number = public.next_ticket_number()
 where ticket_number = '';

-- If tickets already exist, make sure the sequence sits above the highest
-- number so the next insert can't collide with the unique index.
do $$
declare
  max_num bigint;
  seq_num bigint;
begin
  -- Cast per row, then take max. A text max() would compare
  -- lexicographically and rank 'SRC-999999' above 'SRC-1000000'.
  select coalesce(max((nullif(regexp_replace(ticket_number, '\D', '', 'g'), ''))::bigint), 0)
    into max_num
    from public.tickets;

  select last_value into seq_num from public.ticket_number_seq;

  -- Skip on a fresh install so numbering still starts at SRC-000001,
  -- and never move the sequence backwards.
  if max_num > 0 then
    perform setval('public.ticket_number_seq', greatest(max_num, seq_num));
  end if;
end $$;


-- ------------------------------------------------------------
-- 4. Auto-create a profile whenever an auth user is created
--    Doing this in a trigger (rather than a second app-level insert)
--    makes signup atomic — no orphaned auth users if the API dies
--    halfway through.
-- ------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, matric_number, faculty, created_at, updated_at)
  values (
    new.id,
    lower(new.email),
    nullif(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'matric_number', ''),
    nullif(new.raw_user_meta_data->>'faculty', ''),
    now(),
    now()
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ------------------------------------------------------------
-- 5. Signup email-domain policy (defence in depth)
--
--    The API enforces this too, but a direct call to Supabase with
--    the anon key would bypass the API entirely. This trigger makes
--    the rule impossible to sidestep.
-- ------------------------------------------------------------

create or replace function public.enforce_signup_email_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s          public.app_settings%rowtype;
  user_domain text;
  is_allowed  boolean := false;
  d           text;
begin
  select * into s from public.app_settings where id = 1;
  if not found then
    return new; -- no policy configured yet
  end if;

  user_domain := lower(split_part(new.email, '@', 2));

  -- Blocked domains always win, even when restriction is off
  foreach d in array coalesce(s.blocked_domains, array[]::text[]) loop
    if user_domain = lower(d)
       or (s.allow_subdomains and user_domain like '%.' || lower(d)) then
      raise exception 'Email domain "%" is not permitted on this portal.', user_domain
        using errcode = '22023';
    end if;
  end loop;

  if not s.restrict_signup_domains then
    return new;
  end if;

  foreach d in array coalesce(s.allowed_domains, array[]::text[]) loop
    if user_domain = lower(d)
       or (s.allow_subdomains and user_domain like '%.' || lower(d)) then
      is_allowed := true;
    end if;
  end loop;

  if not is_allowed then
    raise exception 'Registration is restricted to approved email domains (%).',
      array_to_string(s.allowed_domains, ', ')
      using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_check_domain on auth.users;
create trigger on_auth_user_check_domain
  before insert on auth.users
  for each row execute function public.enforce_signup_email_domain();


-- ------------------------------------------------------------
-- 6. Denormalised counters kept honest by triggers
--    upvote_count / comment_count are used for sorting, so they
--    must never drift from reality.
-- ------------------------------------------------------------

create or replace function public.sync_ticket_upvote_count()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    update public.tickets set upvote_count = upvote_count + 1 where id = new.ticket_id;
  elsif tg_op = 'DELETE' then
    update public.tickets set upvote_count = greatest(upvote_count - 1, 0) where id = old.ticket_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_ticket_votes_count on public.ticket_votes;
create trigger trg_ticket_votes_count
  after insert or delete on public.ticket_votes
  for each row execute function public.sync_ticket_upvote_count();


create or replace function public.sync_ticket_comment_count()
returns trigger
language plpgsql
as $$
begin
  -- Internal staff notes don't count toward the public tally
  if tg_op = 'INSERT' and new.is_internal = false then
    update public.tickets set comment_count = comment_count + 1 where id = new.ticket_id;
  elsif tg_op = 'DELETE' and old.is_internal = false then
    update public.tickets set comment_count = greatest(comment_count - 1, 0) where id = old.ticket_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_ticket_comments_count on public.ticket_comments;
create trigger trg_ticket_comments_count
  after insert or delete on public.ticket_comments
  for each row execute function public.sync_ticket_comment_count();


create or replace function public.sync_poll_option_vote_count()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    update public.poll_options set vote_count = vote_count + 1 where id = new.option_id;
  elsif tg_op = 'DELETE' then
    update public.poll_options set vote_count = greatest(vote_count - 1, 0) where id = old.option_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_poll_votes_count on public.poll_votes;
create trigger trg_poll_votes_count
  after insert or delete on public.poll_votes
  for each row execute function public.sync_poll_option_vote_count();


-- ------------------------------------------------------------
-- 7. Row Level Security
--
--    The API connects with the service_role key, which bypasses RLS —
--    authorisation is enforced in Express middleware. These policies
--    are a safety net for any direct client access, and are what will
--    make Realtime subscriptions safe in Phase 4f.
--
--    Default posture: deny everything, then allow narrowly.
-- ------------------------------------------------------------

alter table public.profiles           enable row level security;
alter table public.departments        enable row level security;
alter table public.tickets            enable row level security;
alter table public.ticket_attachments enable row level security;
alter table public.ticket_comments    enable row level security;
alter table public.ticket_events      enable row level security;
alter table public.ticket_votes       enable row level security;
alter table public.ticket_ratings     enable row level security;
alter table public.notifications      enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.announcements      enable row level security;
alter table public.polls              enable row level security;
alter table public.poll_options       enable row level security;
alter table public.poll_votes         enable row level security;
alter table public.saved_views        enable row level security;
alter table public.app_settings       enable row level security;
alter table public.audit_logs         enable row level security;

-- Helper: is the caller staff?
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('REP', 'ADMIN') and is_active = true
  );
$$;

-- Profiles: read your own; staff read all
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (id = auth.uid() or public.is_staff());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- Tickets: public board + your own + staff see everything.
-- NOTE: anonymity is enforced by the API serialiser, not here —
-- this policy only controls row visibility.
drop policy if exists tickets_select on public.tickets;
create policy tickets_select on public.tickets
  for select using (
    (is_public = true and is_flagged = false)
    or author_id = auth.uid()
    or public.is_staff()
  );

-- Notifications: strictly your own (this is what Realtime will use)
drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select using (user_id = auth.uid());

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Votes: see all (counts are public), only manage your own
drop policy if exists ticket_votes_select on public.ticket_votes;
create policy ticket_votes_select on public.ticket_votes
  for select using (true);

drop policy if exists ticket_votes_write_own on public.ticket_votes;
create policy ticket_votes_write_own on public.ticket_votes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Comments: visible on tickets you can see; internal notes are staff-only
drop policy if exists ticket_comments_select on public.ticket_comments;
create policy ticket_comments_select on public.ticket_comments
  for select using (
    (is_internal = false and exists (
      select 1 from public.tickets t
      where t.id = ticket_id
        and ((t.is_public = true and t.is_flagged = false) or t.author_id = auth.uid())
    ))
    or public.is_staff()
  );

-- Push subscriptions & saved views: strictly your own
drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists saved_views_own on public.saved_views;
create policy saved_views_own on public.saved_views
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Announcements & polls: readable by any signed-in user once published
drop policy if exists announcements_select on public.announcements;
create policy announcements_select on public.announcements
  for select using (published_at is not null or public.is_staff());

drop policy if exists polls_select on public.polls;
create policy polls_select on public.polls for select using (true);

drop policy if exists poll_options_select on public.poll_options;
create policy poll_options_select on public.poll_options for select using (true);

drop policy if exists poll_votes_own on public.poll_votes;
create policy poll_votes_own on public.poll_votes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists departments_select on public.departments;
create policy departments_select on public.departments for select using (true);

-- app_settings and audit_logs: no client policies at all.
-- Service role only (admin API). Deny-by-default handles it.


-- ------------------------------------------------------------
-- 8. Seed SRC departments
-- ------------------------------------------------------------

insert into public.departments (id, name, slug, description, is_active, created_at)
values
  (gen_random_uuid(), 'Academic Affairs',   'academic',       'Lectures, results, timetables, examinations', true, now()),
  (gen_random_uuid(), 'ICT & Networks',     'ict',            'Wi-Fi, portal access, computer labs',         true, now()),
  (gen_random_uuid(), 'Works & Maintenance','infrastructure', 'Buildings, power, water, roads',              true, now()),
  (gen_random_uuid(), 'Student Welfare',    'welfare',        'Hostels, cafeteria, health, security',        true, now()),
  (gen_random_uuid(), 'Administration',     'administration', 'Fees, records, general administration',       true, now()),
  (gen_random_uuid(), 'General',            'general',        'Anything that does not fit elsewhere',        true, now())
on conflict (slug) do nothing;
