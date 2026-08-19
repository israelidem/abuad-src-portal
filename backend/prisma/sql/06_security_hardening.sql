-- ============================================================
-- Phase 6 — Security hardening (P0 + P1 from the audit)
--
-- Run in the Supabase SQL Editor, or:
--   psql "$DIRECT_URL" -f prisma/sql/06_security_hardening.sql
--
-- Every statement is idempotent — safe to run more than once.
--
-- WHAT THIS FIXES
--
--   P0  profiles.role was writable by its owner. `profiles_update_own`
--       granted UPDATE with `with check (id = auth.uid())`, which checks
--       *which row* you may write but never *which columns*. Any student
--       holding the anon key could therefore run
--
--         supabase.from('profiles').update({ role: 'SUPER_ADMIN' })
--
--       and become the absolute admin. Fixed below at two levels.
--
--   P1  Write policies were missing on most user-writable tables. RLS
--       denies by default, so this was latent rather than live — but the
--       moment a policy is added for convenience, `author_id` spoofing
--       becomes possible. The `with check` clauses below pin every insert
--       to auth.uid().
--
--   P1  Anonymity was an API-layer guarantee only. `tickets_select`
--       returns the whole row, so a direct PostgREST read of the public
--       board exposed `author_id` for anonymous tickets. Closed with a
--       column-level REVOKE.
--
-- HOW THE TWO ENFORCEMENT LAYERS DIFFER
--
--   Column privileges (REVOKE) are checked before RLS and cannot be
--   overridden by a policy. They are the primary control.
--
--   The trigger is the backstop: it survives someone later running
--   `GRANT ALL ON profiles TO authenticated` (which would silently undo
--   the REVOKE) and it also catches writes routed through a
--   SECURITY DEFINER function.
--
-- WHY THIS DOES NOT BREAK THE EXPRESS API
--
--   Prisma connects with the credentials in DATABASE_URL — the `postgres`
--   role, which owns these tables. Table owners bypass RLS and hold all
--   column privileges implicitly, so admin role changes through
--   /api/admin/users/:id/role keep working exactly as before. The
--   restrictions below apply only to `anon` and `authenticated`, the two
--   roles PostgREST switches into for browser traffic.
--
--   Row level security is NOT forced (no FORCE ROW LEVEL SECURITY), which
--   is what preserves that owner bypass. Do not add it without first
--   moving the API onto a non-owner role.
-- ============================================================


-- ------------------------------------------------------------
-- 0. Preconditions
--
-- is_staff() / is_super_admin() are created in 04_phase4.sql. Recreated
-- here so this file can be applied to a database where 04 was missed —
-- the audit could not prove 01..05 were all applied in order.
-- ------------------------------------------------------------

create or replace function public.is_staff()
returns boolean
language sql
stable
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

create or replace function public.is_super_admin()
returns boolean
language sql
stable
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

/**
 * True when the current database session is browser traffic arriving
 * through PostgREST.
 *
 * PostgREST authenticates as `authenticator` and then SET ROLEs to `anon`
 * or `authenticated` for the duration of the request. Prisma and psql
 * connect as `postgres`. Testing current_user is therefore how we tell
 * "a student's browser" from "our own server", without trusting anything
 * the client sends.
 */
create or replace function public.is_client_session()
returns boolean
language sql
stable
as $$
  select current_user in ('anon', 'authenticated');
$$;


-- ============================================================
-- 1. P0 — protect profiles.role and the other authorisation columns
-- ============================================================

-- ------------------------------------------------------------
-- 1a. Column-level privileges (primary control)
--
-- `authenticated` keeps UPDATE on the columns a student is *meant* to
-- edit, and loses it on everything that decides what they can do.
-- Granting per-column replaces the table-wide UPDATE that Supabase's
-- default grants hand out.
-- ------------------------------------------------------------

-- Revoke the blanket table-level UPDATE first: a table-wide grant
-- outranks the absence of a column grant.
revoke update on public.profiles from authenticated;
revoke update on public.profiles from anon;

-- Re-grant only the user-editable columns.
grant update (full_name, matric_number, faculty, department, avatar_url)
  on public.profiles to authenticated;

-- Deliberately NOT granted, and why:
--   role                   → privilege escalation (the P0)
--   is_active              → self-reactivation after a ban
--   id                     → identity takeover (would repoint the auth FK)
--   email                  → auth.users is the source of truth for this
--   email_verified_domain  → bypasses the signup domain policy
--   department_id          → which SRC desk a rep staffs; grants queue access
--   created_at, updated_at → audit fields

-- Nobody signed out has any business writing a profile.
revoke insert, delete on public.profiles from anon, authenticated;


-- ------------------------------------------------------------
-- 1b. Trigger backstop
--
-- Runs regardless of how the UPDATE arrived. Compares old and new on
-- the protected columns and refuses the write when the session is a
-- browser and the caller is not already a super admin.
--
-- `is distinct from` rather than `<>` so a NULL on either side is
-- handled — `null <> null` is null, which would read as "unchanged" and
-- let a null-to-value change slip through.
-- ------------------------------------------------------------

create or replace function public.protect_profile_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Server-side writes (Prisma, psql, migrations) pass straight through.
  -- Those paths are already gated by requireAdmin / requireSuperAdmin in
  -- Express, which is where role changes are supposed to be authorised.
  if not public.is_client_session() then
    return new;
  end if;

  -- A super admin acting through the client is still allowed, so this
  -- trigger can never lock the portal's owner out of their own database.
  if public.is_super_admin() then
    return new;
  end if;

  if new.role is distinct from old.role then
    raise exception
      'Changing your own role is not permitted.'
      using errcode = '42501', -- insufficient_privilege
            hint = 'Roles are assigned by an administrator through the admin console.';
  end if;

  if new.is_active is distinct from old.is_active then
    raise exception 'Changing account status is not permitted.'
      using errcode = '42501';
  end if;

  if new.id is distinct from old.id then
    raise exception 'Changing a profile id is not permitted.'
      using errcode = '42501';
  end if;

  if new.email is distinct from old.email then
    raise exception 'Change your email through account settings, not the profile row.'
      using errcode = '42501';
  end if;

  if new.email_verified_domain is distinct from old.email_verified_domain then
    raise exception 'Changing domain verification is not permitted.'
      using errcode = '42501';
  end if;

  if new.department_id is distinct from old.department_id then
    raise exception 'Department assignment is an administrator action.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_protect_profile_columns on public.profiles;
create trigger trg_protect_profile_columns
  before update on public.profiles
  for each row execute function public.protect_profile_privileged_columns();


-- ------------------------------------------------------------
-- 1c. Tighten the row policies themselves
--
-- The original `profiles_update_own` stays functionally the same (own row
-- only) — the column controls above are what actually fixed the P0. The
-- policy is recreated here only to add an explicit staff read path and to
-- document that `with check` alone was never sufficient.
-- ------------------------------------------------------------

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (id = auth.uid() or public.is_staff());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- No INSERT policy: profiles are created by the on_auth_user_created
-- trigger, which runs as the definer and is unaffected by RLS.
-- No DELETE policy: profiles die with their auth.users row via cascade.


-- ============================================================
-- 2. P1 — anonymity enforced at the database, not just the serialiser
--
-- serialiseTicket() in the API strips the author from anonymous tickets,
-- and every API response goes through it. But `tickets_select` lets a
-- browser read the row directly with the anon key, author_id included —
-- so anonymity held only as long as nobody bypassed Express.
--
-- The frontend never reads tickets through PostgREST (confirmed: the only
-- supabase-js calls in frontend/src are storage uploads), so removing
-- column access costs the application nothing.
-- ============================================================

revoke select (author_id) on public.tickets from anon, authenticated;

-- Same reasoning for the timeline: ticket_events.actor_id on a CREATED
-- event is the anonymous author by another name.
revoke select (actor_id) on public.ticket_events from anon, authenticated;


-- ============================================================
-- 3. P1 — write policies with ownership pinned to auth.uid()
--
-- Each of these tables previously had SELECT policies but no INSERT or
-- UPDATE policy. RLS denies by default, so nothing was exploitable today.
-- They are written explicitly so that "add a policy so the client can
-- post a comment" can never become "any client can post as anyone".
--
-- The pattern throughout: `using` controls which existing rows you may
-- touch, `with check` controls what the row is allowed to look like
-- afterwards. An INSERT policy without `with check` is the author_id
-- spoofing bug the audit warned about.
-- ============================================================

-- ------------------------------------------------------------
-- 3a. Tickets
-- ------------------------------------------------------------

drop policy if exists tickets_select on public.tickets;
create policy tickets_select on public.tickets
  for select using (
    (is_public = true and is_flagged = false)
    or author_id = auth.uid()
    or assigned_to_id = auth.uid()
    or public.is_staff()
  );

drop policy if exists tickets_insert_own on public.tickets;
create policy tickets_insert_own on public.tickets
  for insert with check (author_id = auth.uid());

-- Students may only touch their own ticket, and only while it is still
-- PENDING — the same rule canEditTicket() applies in the API. Staff are
-- unrestricted, which is what the assign/status endpoints rely on.
drop policy if exists tickets_update_own_or_staff on public.tickets;
create policy tickets_update_own_or_staff on public.tickets
  for update
  using (
    public.is_staff()
    or (author_id = auth.uid() and status = 'PENDING')
  )
  with check (
    public.is_staff()
    or author_id = auth.uid()
  );

drop policy if exists tickets_delete_own_or_staff on public.tickets;
create policy tickets_delete_own_or_staff on public.tickets
  for delete
  using (
    public.is_staff()
    or (author_id = auth.uid() and status = 'PENDING')
  );

-- The counters are trigger-maintained and drive sort order. A client that
-- could write them could pin its own ticket to the top of the board.
revoke update (upvote_count, comment_count, ticket_number, author_id)
  on public.tickets from anon, authenticated;


-- ------------------------------------------------------------
-- 3b. Comments
-- ------------------------------------------------------------

drop policy if exists ticket_comments_select on public.ticket_comments;
create policy ticket_comments_select on public.ticket_comments
  for select using (
    (is_internal = false and exists (
      select 1 from public.tickets t
      where t.id = ticket_id
        and ((t.is_public = true and t.is_flagged = false)
             or t.author_id = auth.uid()
             or t.assigned_to_id = auth.uid())
    ))
    or public.is_staff()
  );

-- Commenting requires being able to see the ticket, so the visibility
-- test is repeated here. Without it a student could comment on a private
-- ticket whose id they guessed.
drop policy if exists ticket_comments_insert_own on public.ticket_comments;
create policy ticket_comments_insert_own on public.ticket_comments
  for insert with check (
    author_id = auth.uid()
    and (
      public.is_staff()
      or exists (
        select 1 from public.tickets t
        where t.id = ticket_id
          and ((t.is_public = true and t.is_flagged = false)
               or t.author_id = auth.uid()
               or t.assigned_to_id = auth.uid())
      )
    )
  );

drop policy if exists ticket_comments_update_own on public.ticket_comments;
create policy ticket_comments_update_own on public.ticket_comments
  for update using (author_id = auth.uid()) with check (author_id = auth.uid());

drop policy if exists ticket_comments_delete_own_or_staff on public.ticket_comments;
create policy ticket_comments_delete_own_or_staff on public.ticket_comments
  for delete using (author_id = auth.uid() or public.is_staff());

-- is_internal decides whether students ever see the note. A client that
-- could flip it could unmask staff deliberation, or hide its own comment
-- from moderation.
revoke update (is_internal, author_id, ticket_id)
  on public.ticket_comments from anon, authenticated;


-- ------------------------------------------------------------
-- 3c. Votes and ratings — "not another user's"
-- ------------------------------------------------------------

-- Totals are public, so SELECT stays open. Writes are pinned to the
-- caller: `for all` covers insert/update/delete in one policy, and the
-- `with check` is what stops user_id being set to someone else.
drop policy if exists ticket_votes_write_own on public.ticket_votes;
create policy ticket_votes_write_own on public.ticket_votes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists ticket_ratings_own on public.ticket_ratings;
create policy ticket_ratings_own on public.ticket_ratings
  for all
  using (user_id = auth.uid() or public.is_staff())
  with check (user_id = auth.uid());

revoke update (user_id) on public.ticket_votes   from anon, authenticated;
revoke update (user_id) on public.ticket_ratings from anon, authenticated;
revoke update (user_id) on public.poll_votes     from anon, authenticated;


-- ------------------------------------------------------------
-- 3d. Notifications — read your own, and only ever mark them read
--
-- The old `notifications_update_own` allowed a user to rewrite the title
-- and body of their own notifications. Harmless alone, but it means the
-- bell is no longer evidence of what the system actually said — so the
-- writable surface is narrowed to is_read.
-- ------------------------------------------------------------

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select using (user_id = auth.uid());

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke update on public.notifications from anon, authenticated;
grant  update (is_read) on public.notifications to authenticated;

-- Notifications are created by the API only. No INSERT policy, and the
-- privilege is revoked so a future permissive policy can't resurrect it:
-- a client that could insert could fake "your ticket was resolved".
revoke insert, delete on public.notifications from anon, authenticated;


-- ------------------------------------------------------------
-- 3e. Attachments
--
-- No policy existed at all, so RLS denied everything — correct by
-- accident. Made explicit and scoped to the parent ticket's visibility,
-- so evidence on a private report is not readable by row id alone.
-- ------------------------------------------------------------

drop policy if exists ticket_attachments_select on public.ticket_attachments;
create policy ticket_attachments_select on public.ticket_attachments
  for select using (
    exists (
      select 1 from public.tickets t
      where t.id = ticket_id
        and ((t.is_public = true and t.is_flagged = false)
             or t.author_id = auth.uid()
             or t.assigned_to_id = auth.uid()
             or public.is_staff())
    )
  );

drop policy if exists ticket_attachments_insert_own on public.ticket_attachments;
create policy ticket_attachments_insert_own on public.ticket_attachments
  for insert with check (
    exists (
      select 1 from public.tickets t
      where t.id = ticket_id and t.author_id = auth.uid()
    )
  );

drop policy if exists ticket_attachments_delete_own_or_staff on public.ticket_attachments;
create policy ticket_attachments_delete_own_or_staff on public.ticket_attachments
  for delete using (
    public.is_staff()
    or exists (
      select 1 from public.tickets t
      where t.id = ticket_id and t.author_id = auth.uid()
    )
  );


-- ------------------------------------------------------------
-- 3f. Ticket events — read-only timeline
--
-- Visible with the ticket, writable by nobody. The timeline is the
-- portal's audit record; a client that could insert or amend it could
-- manufacture a resolution that never happened.
-- ------------------------------------------------------------

drop policy if exists ticket_events_select on public.ticket_events;
create policy ticket_events_select on public.ticket_events
  for select using (
    exists (
      select 1 from public.tickets t
      where t.id = ticket_id
        and ((t.is_public = true and t.is_flagged = false)
             or t.author_id = auth.uid()
             or t.assigned_to_id = auth.uid()
             or public.is_staff())
    )
  );

revoke insert, update, delete on public.ticket_events from anon, authenticated;


-- ------------------------------------------------------------
-- 3g. Departments, settings and audit logs
-- ------------------------------------------------------------

-- The signup form and ticket form both need the department list while
-- signed out, so SELECT stays public. Writes are admin-only via the API.
drop policy if exists departments_select on public.departments;
create policy departments_select on public.departments for select using (true);

revoke insert, update, delete on public.departments from anon, authenticated;

-- app_settings holds the domain allow/block lists and the maintenance
-- banner. Super admin only, reads included.
drop policy if exists app_settings_super_admin on public.app_settings;
create policy app_settings_super_admin on public.app_settings
  for all using (public.is_super_admin()) with check (public.is_super_admin());

-- audit_logs must be append-only from the application and unreadable
-- from the client. An audit trail an admin can edit is not an audit
-- trail, so even super admins get no client-side write path here.
revoke all on public.audit_logs from anon, authenticated;


-- ============================================================
-- 4. Verification
--
-- Run these after applying. Each has an expected result stated with it.
-- ============================================================

-- 4a. Which columns of `profiles` can a signed-in browser still write?
--     EXPECTED: exactly avatar_url, department, faculty, full_name,
--     matric_number. If `role` or `is_active` appears here, stop — the
--     P0 is still open.
select string_agg(column_name, ', ' order by column_name) as authenticated_writable_profile_columns
from information_schema.column_privileges
where table_schema = 'public'
  and table_name   = 'profiles'
  and grantee      = 'authenticated'
  and privilege_type = 'UPDATE';

-- 4b. Is author_id still readable by a browser?
--     EXPECTED: 0 rows. Any row means anonymity is still bypassable.
select column_name, grantee
from information_schema.column_privileges
where table_schema = 'public'
  and table_name   = 'tickets'
  and column_name  = 'author_id'
  and grantee in ('anon', 'authenticated')
  and privilege_type = 'SELECT';

-- 4c. Is the trigger installed?
--     EXPECTED: one row, tgenabled = 'O'.
select tgname, tgenabled
from pg_trigger
where tgrelid = 'public.profiles'::regclass
  and tgname = 'trg_protect_profile_columns';

-- 4d. Full policy inventory for review.
select tablename, policyname, cmd,
       coalesce(qual, '—')       as using_expr,
       coalesce(with_check, '—') as with_check_expr
from pg_policies
where schemaname = 'public'
order by tablename, cmd, policyname;

-- 4e. Any RLS-enabled table with no policy at all is a silent deny —
--     fine if intentional (app_settings, audit_logs), a bug otherwise.
select c.relname as table_without_policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relrowsecurity
  and not exists (select 1 from pg_policies p
                  where p.schemaname = 'public' and p.tablename = c.relname)
order by 1;


-- ============================================================
-- 5. Negative test — prove the P0 is closed
--
-- These cannot run as `postgres` (the owner bypasses everything, so they
-- would wrongly succeed). Run them from the browser console of a signed-in
-- student instead, against the anon key:
--
--   const { error } = await supabase.from('profiles')
--     .update({ role: 'SUPER_ADMIN' }).eq('id', (await supabase.auth.getUser()).data.user.id);
--   console.log(error);
--
-- EXPECTED: a non-null error. Either
--   42501 permission denied for column role   (column REVOKE fired), or
--   42501 Changing your own role is not permitted. (trigger fired)
--
-- Then confirm the role really is unchanged — an error with a committed
-- write would be the worst of both worlds:
--
--   await supabase.from('profiles').select('role').single();
--
-- EXPECTED: still 'STUDENT'.
--
-- And confirm the legitimate path still works:
--
--   await supabase.from('profiles').update({ full_name: 'Ada Lovelace' })
--     .eq('id', (await supabase.auth.getUser()).data.user.id);
--
-- EXPECTED: no error.
-- ============================================================
