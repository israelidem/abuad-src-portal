-- ============================================================
-- 11_feedback_and_ratings.sql
--
-- Task §9 (portal feedback) and §10 (in-app portal rating).
--
-- ADDITIVE ONLY. Two new tables, no changes to existing ones.
--
-- Idempotent — safe to re-run.
--
-- ------------------------------------------------------------
-- HOW TO RUN THIS
-- ------------------------------------------------------------
--     node backend/scripts/apply-sql.mjs 11_feedback_and_ratings.sql
--
-- Use the runner, not the Supabase SQL editor: the editor wraps a pasted
-- script in one implicit transaction, so one failing statement silently
-- rolls back the statements that already succeeded (how migration 07
-- failed).
--
-- ------------------------------------------------------------
-- WHY THESE ARE SEPARATE FROM WHAT ALREADY EXISTS
-- ------------------------------------------------------------
-- portal_feedback vs tickets:
--   A ticket is an SRC complaint routed to a department and worked by
--   student representatives. Portal feedback is a bug report about the
--   software, read by whoever maintains it. Same shape, different
--   audience, different lifecycle, different notification behaviour.
--   Putting "the star button is broken on iPhone" into the Welfare
--   department queue would bury it and waste a caseworker's time.
--
-- portal_ratings vs ticket_ratings:
--   ticket_ratings already exists and is one row per ticket — "how well
--   was my complaint handled". portal_ratings is one row per user per
--   period — "how good is this portal". Reusing ticket_ratings would mean
--   a nullable ticket_id and every existing average-satisfaction query
--   silently changing meaning.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Portal feedback
-- ------------------------------------------------------------

create table if not exists public.portal_feedback (
  id            uuid primary key default gen_random_uuid(),

  -- Nullable + SET NULL: deleting an account must not delete the bug
  -- reports it filed. A report describing a reproducible crash keeps its
  -- value after the reporter graduates.
  user_id       uuid references public.profiles(id) on delete set null,

  category      text not null,
  subject       text not null,
  description   text not null,

  -- Cloudinary public_id, same convention as ticket_attachments.
  -- storage_path. Single, not a list: a screenshot of the broken screen
  -- is the useful case, and a gallery is not worth the extra table.
  screenshot_path text,

  status        text not null default 'NEW',

  -- Diagnostic metadata, captured at submit time. "The page went blank"
  -- is unactionable without knowing the browser; asking the reporter to
  -- find their user agent is worse than reading it.
  --
  -- Deliberately NOT stored: IP address. It would make every feedback row
  -- personal data under a retention obligation, to diagnose bugs that the
  -- user agent and page URL already explain.
  user_agent    text,
  page_url      text,
  app_version   text,

  -- Staff-only. Kept on the row rather than in a separate notes table
  -- because there is one triage note per item in practice.
  admin_notes   text,
  resolved_by   uuid references public.profiles(id) on delete set null,
  resolved_at   timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- CHECK rather than a Postgres enum, consistent with migration 10:
-- adding a value to an enum needs ALTER TYPE and cannot run in every
-- transaction context, while a CHECK is replaced by one idempotent pair.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'portal_feedback_category_check'
  ) then
    alter table public.portal_feedback
      add constraint portal_feedback_category_check
      check (category in (
        'GENERAL', 'SUGGESTION', 'BUG', 'TECHNICAL', 'USABILITY', 'OTHER'
      ));
  end if;

  -- The brief's four states. IN_REVIEW is distinct from NEW so a reporter
  -- can be told someone is looking, and CLOSED is distinct from RESOLVED
  -- so "fixed" and "not going to fix" are not the same word.
  if not exists (
    select 1 from pg_constraint where conname = 'portal_feedback_status_check'
  ) then
    alter table public.portal_feedback
      add constraint portal_feedback_status_check
      check (status in ('NEW', 'IN_REVIEW', 'RESOLVED', 'CLOSED'));
  end if;

  -- Length bounds in the database as well as the API. The API validator is
  -- the good error message; this is the guarantee. Without it, a caller
  -- reaching the table by another path could store a 10MB description.
  if not exists (
    select 1 from pg_constraint where conname = 'portal_feedback_subject_length_check'
  ) then
    alter table public.portal_feedback
      add constraint portal_feedback_subject_length_check
      check (char_length(subject) between 3 and 160);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'portal_feedback_description_length_check'
  ) then
    alter table public.portal_feedback
      add constraint portal_feedback_description_length_check
      check (char_length(description) between 10 and 4000);
  end if;
end $$;

-- The admin list is "status = ? order by created_at desc", paginated.
create index if not exists portal_feedback_status_created_idx
  on public.portal_feedback (status, created_at desc);

-- Open items across all statuses — the default landing view.
create index if not exists portal_feedback_open_idx
  on public.portal_feedback (created_at desc)
  where status in ('NEW', 'IN_REVIEW');

-- "My submissions", and the rate-limit lookup that counts a user's
-- recent rows.
create index if not exists portal_feedback_user_created_idx
  on public.portal_feedback (user_id, created_at desc);


-- ------------------------------------------------------------
-- 2. Portal ratings
-- ------------------------------------------------------------

create table if not exists public.portal_ratings (
  id           uuid primary key default gen_random_uuid(),

  -- CASCADE here, unlike portal_feedback: an aggregate star score has no
  -- standalone value once the account is gone, and keeping orphaned rows
  -- would skew the average with votes from users who no longer exist.
  user_id      uuid not null references public.profiles(id) on delete cascade,

  stars        smallint not null,
  reason       text,

  -- Which prompt produced this. Lets a later rating be compared against
  -- an earlier one for the same user instead of overwriting it, so a
  -- trend is visible rather than only the latest opinion.
  prompt_round integer not null default 1,

  app_version  text,

  -- Dismissals are recorded as rows too — see below.
  dismissed    boolean not null default false,

  created_at   timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'portal_ratings_stars_check'
  ) then
    -- 0 is reserved for a dismissal, which carries no score. 1-5 are real
    -- ratings. A dismissal must be stored so the prompt knows not to ask
    -- again, and a NULL star column would make every average query need a
    -- filter that someone will eventually forget.
    alter table public.portal_ratings
      add constraint portal_ratings_stars_check
      check (stars between 0 and 5);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'portal_ratings_dismissed_consistency_check'
  ) then
    -- Ties the two columns together so the table cannot hold a row that
    -- claims to be both a dismissal and a 4-star rating.
    alter table public.portal_ratings
      add constraint portal_ratings_dismissed_consistency_check
      check ((dismissed = true and stars = 0) or (dismissed = false and stars between 1 and 5));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'portal_ratings_reason_length_check'
  ) then
    alter table public.portal_ratings
      add constraint portal_ratings_reason_length_check
      check (reason is null or char_length(reason) <= 1000);
  end if;
end $$;

-- One rating per user per round, enforced in the database.
--
-- This is the anti-abuse mechanism for §10, and it belongs here rather
-- than in the API: two concurrent submits both pass an application-level
-- "have you already rated?" check and both insert. A unique index makes
-- the second one fail regardless of timing.
create unique index if not exists portal_ratings_user_round_key
  on public.portal_ratings (user_id, prompt_round);

-- The admin dashboard reads score distribution over time.
create index if not exists portal_ratings_created_idx
  on public.portal_ratings (created_at desc)
  where dismissed = false;

-- The prompt asks "has this user already responded?" on session start.
create index if not exists portal_ratings_user_idx
  on public.portal_ratings (user_id, created_at desc);


-- ------------------------------------------------------------
-- 3. RLS and client grants
-- ------------------------------------------------------------
-- Consistent with 01, 06 and 10: RLS on, no policies, no grants to anon
-- or authenticated. The API connects as service_role and authorisation is
-- enforced in Express. With RLS enabled and zero policies, a leaked anon
-- key reaches nothing here.
--
-- This matters more than usual for these two tables:
--
--   portal_feedback holds free text that may name staff or describe
--   security problems. Client-readable feedback would publish one
--   student's complaint to every other student.
--
--   portal_ratings maps a user id to an opinion of the portal. Readable
--   ratings would let students see who rated the SRC's software badly.

alter table public.portal_feedback enable row level security;
alter table public.portal_ratings  enable row level security;

revoke all on public.portal_feedback from anon, authenticated;
revoke all on public.portal_ratings  from anon, authenticated;


-- ------------------------------------------------------------
-- 4. Verify
-- ------------------------------------------------------------
-- Expect 2 tables, RLS on for both, 0 policies, and the two uniqueness /
-- consistency guarantees present.

select 'new tables' as check_name, count(*) as found, 2 as expected
  from information_schema.tables
 where table_schema = 'public'
   and table_name in ('portal_feedback', 'portal_ratings')
union all
select 'rls enabled', count(*), 2
  from pg_tables
 where schemaname = 'public'
   and tablename in ('portal_feedback', 'portal_ratings')
   and rowsecurity = true
union all
select 'policies (must be 0)', count(*), 0
  from pg_policies
 where schemaname = 'public'
   and tablename in ('portal_feedback', 'portal_ratings')
union all
select 'one-rating-per-round index', count(*), 1
  from pg_indexes
 where schemaname = 'public' and indexname = 'portal_ratings_user_round_key'
union all
select 'dismissal consistency check', count(*), 1
  from pg_constraint
 where conname = 'portal_ratings_dismissed_consistency_check';
