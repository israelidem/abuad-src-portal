-- ============================================================
-- 10_comment_moderation.sql
--
-- Automatic comment moderation: per-comment moderation state, an
-- admin-managed word list, and an audit trail of moderator decisions.
--
-- ADDITIVE ONLY. No drops, no type changes, no data rewrites. Every new
-- column has a default, so existing ticket_comments rows are backfilled
-- in place and keep working untouched.
--
-- Idempotent — safe to re-run (IF NOT EXISTS / IF EXISTS throughout).
--
-- ------------------------------------------------------------
-- HOW TO RUN THIS
-- ------------------------------------------------------------
-- Prefer the runner, which sends each statement separately:
--
--     node backend/scripts/apply-sql.mjs 10_comment_moderation.sql
--
-- The Supabase SQL editor wraps a pasted script in ONE implicit
-- transaction, so a single failing statement silently rolls back the
-- ALTERs that already succeeded (this is how migration 07 failed).
--
-- ------------------------------------------------------------
-- WHY THESE SHAPES
-- ------------------------------------------------------------
-- moderation_status on the comment, not a separate queue table:
--   the queue is "comments whose status is PENDING", which is one
--   indexed scan. A parallel queue table would need to stay in sync with
--   comment deletion, and drift there means a moderator reviewing a
--   comment that no longer exists.
--
-- is_hidden separate from moderation_status:
--   status is the workflow state, visibility is the consequence. They
--   are not the same axis — a high-severity match is hidden pending
--   review, while a medium match stays visible but queued. Collapsing
--   them into one column loses the ability to queue without censoring.
--
-- moderation_words as a table, not a config constant:
--   the brief requires custom words to take effect without a
--   deployment or restart. A DB row read through a short-lived cache
--   does that; a constant in a .js file cannot.
--
-- ============================================================


-- ------------------------------------------------------------
-- 1. Moderation state on each comment
-- ------------------------------------------------------------
-- APPROVED is the default so every pre-existing comment, and every
-- comment that the filter never objects to, is in a terminal state and
-- never appears in the moderation queue. Only the filter (or a
-- moderator) moves a row off APPROVED.
--
-- Values, kept as text + CHECK rather than a Postgres enum: adding a
-- value to an enum in production requires ALTER TYPE and cannot run
-- inside some transaction contexts, whereas a CHECK constraint is
-- edited with one idempotent DDL pair.
--
--   APPROVED  visible; no action needed (default)
--   PENDING   filter flagged it; awaiting a moderator
--   REJECTED  moderator judged it a violation; hidden
--   RESOLVED  moderator handled it out-of-band; no longer in queue

alter table public.ticket_comments
  add column if not exists moderation_status text not null default 'APPROVED';

alter table public.ticket_comments
  add column if not exists moderation_reason text;

alter table public.ticket_comments
  add column if not exists moderation_categories text[] not null default '{}';

alter table public.ticket_comments
  add column if not exists moderation_severity text;

-- Hidden from students but retained for moderators. Never hard-delete on
-- an automatic signal: the filter is heuristic, and a false positive
-- must be recoverable.
alter table public.ticket_comments
  add column if not exists is_hidden boolean not null default false;

alter table public.ticket_comments
  add column if not exists moderated_by uuid;

alter table public.ticket_comments
  add column if not exists moderated_at timestamptz;

alter table public.ticket_comments
  add column if not exists flagged_at timestamptz;

-- Constraints added separately from the columns so a re-run does not
-- fail on "constraint already exists".
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ticket_comments_moderation_status_check'
  ) then
    alter table public.ticket_comments
      add constraint ticket_comments_moderation_status_check
      check (moderation_status in ('APPROVED', 'PENDING', 'REJECTED', 'RESOLVED'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'ticket_comments_moderation_severity_check'
  ) then
    alter table public.ticket_comments
      add constraint ticket_comments_moderation_severity_check
      check (moderation_severity is null or moderation_severity in ('low', 'medium', 'high'));
  end if;

  -- ON DELETE SET NULL, not CASCADE: deleting a moderator's account must
  -- not delete the comments they moderated. The audit row in
  -- moderation_actions keeps the actor id regardless.
  if not exists (
    select 1 from pg_constraint where conname = 'ticket_comments_moderated_by_fkey'
  ) then
    alter table public.ticket_comments
      add constraint ticket_comments_moderated_by_fkey
      foreign key (moderated_by) references public.profiles(id) on delete set null;
  end if;
end $$;

-- The moderation queue query is
--   where moderation_status = 'PENDING' order by flagged_at desc
-- so a partial index on exactly that predicate keeps the queue O(matching
-- rows) instead of scanning every comment ever posted. Partial, because
-- APPROVED will be ~99% of the table and indexing it is dead weight.
create index if not exists ticket_comments_moderation_queue_idx
  on public.ticket_comments (moderation_status, flagged_at desc)
  where moderation_status in ('PENDING', 'REJECTED');

-- Rendering a ticket's comments filters hidden rows for students.
create index if not exists ticket_comments_ticket_visible_idx
  on public.ticket_comments (ticket_id, is_hidden, created_at);


-- ------------------------------------------------------------
-- 2. Admin-managed moderation words
-- ------------------------------------------------------------
-- Terms live here so an admin can add one and have it apply to the next
-- comment posted, with no deploy and no restart. The built-in list stays
-- in backend/src/config/moderationWordlist.js: it is version-controlled,
-- reviewed, and must not be silently editable in production.

create table if not exists public.moderation_words (
  id          uuid primary key default gen_random_uuid(),
  -- The term as the admin typed it, for display and editing.
  term        text        not null,
  -- Normalised form, used for duplicate detection. The matcher normalises
  -- at read time; this column exists so "Idiot", "idiot " and "1d10t"
  -- cannot all be added as separate rows that mean the same thing.
  normalised  text        not null,
  category    text        not null default 'CUSTOM',
  severity    text        not null default 'medium',
  -- Disable rather than delete: a term that caused false positives should
  -- be switchable off while keeping the record of who added it and why.
  is_enabled  boolean     not null default true,
  notes       text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'moderation_words_severity_check'
  ) then
    alter table public.moderation_words
      add constraint moderation_words_severity_check
      check (severity in ('low', 'medium', 'high'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'moderation_words_term_length_check'
  ) then
    -- Lower bound blocks a one-character term, which would match a large
    -- fraction of ordinary comments and effectively DoS the queue.
    alter table public.moderation_words
      add constraint moderation_words_term_length_check
      check (char_length(term) between 2 and 120);
  end if;
end $$;

-- One row per distinct normalised term. Enforced in the database, not
-- just in the API, so a concurrent double-submit cannot create a
-- duplicate pair.
create unique index if not exists moderation_words_normalised_key
  on public.moderation_words (normalised);

-- The matcher loads only enabled rows.
create index if not exists moderation_words_enabled_idx
  on public.moderation_words (is_enabled)
  where is_enabled = true;


-- ------------------------------------------------------------
-- 3. Moderation audit trail
-- ------------------------------------------------------------
-- Separate from audit_logs because these rows are queried per comment
-- ("show me this comment's history") and audit_logs is an append-only
-- firehose keyed by actor. Both are written; this one is readable by
-- moderators in the UI.

create table if not exists public.moderation_actions (
  id           uuid primary key default gen_random_uuid(),
  comment_id   uuid not null references public.ticket_comments(id) on delete cascade,
  -- Nullable + SET NULL: an account can be deleted, and the history of
  -- what was decided must survive that. actor_role is denormalised so a
  -- later demotion does not rewrite history.
  actor_id     uuid references public.profiles(id) on delete set null,
  actor_role   text,
  action       text not null,
  reason       text,
  from_status  text,
  to_status    text,
  created_at   timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'moderation_actions_action_check'
  ) then
    alter table public.moderation_actions
      add constraint moderation_actions_action_check
      check (action in (
        'AUTO_FLAGGED', 'APPROVED', 'REJECTED', 'RESOLVED', 'HIDDEN', 'UNHIDDEN'
      ));
  end if;
end $$;

create index if not exists moderation_actions_comment_idx
  on public.moderation_actions (comment_id, created_at desc);


-- ------------------------------------------------------------
-- 4. RLS and client grants
-- ------------------------------------------------------------
-- Consistent with 01_post_migration.sql and 06_security_hardening.sql:
-- RLS is on for every table, the API connects as service_role (which
-- bypasses RLS), and authorisation is enforced in Express middleware.
-- These grants exist so that a leaked anon/authenticated key cannot
-- reach moderation data directly.

alter table public.moderation_words   enable row level security;
alter table public.moderation_actions enable row level security;

-- No policies are created for either table, so with RLS enabled and no
-- policy, anon and authenticated get nothing — deny by default.
--
-- The word list in particular must not be client-readable: publishing
-- the exact blocklist is a bypass manual. The brief's "do not expose the
-- moderation implementation to normal users" is enforced here at the
-- database, not only in the API layer.
revoke all on public.moderation_words   from anon, authenticated;
revoke all on public.moderation_actions from anon, authenticated;

-- Moderation state on a comment is staff-only. A student must not be
-- able to read moderation_reason (it quotes the matched terms) or
-- discover that their comment is queued rather than merely unpopular.
revoke select (moderation_reason, moderation_categories, moderation_severity,
               moderated_by, moderated_at, moderation_status, flagged_at)
  on public.ticket_comments from anon, authenticated;


-- ------------------------------------------------------------
-- 5. Verify
-- ------------------------------------------------------------
-- Expect: 8 new columns on ticket_comments, 2 new tables, RLS on for
-- both, and zero policies on either.

select 'ticket_comments columns' as check_name, count(*) as found, 8 as expected
  from information_schema.columns
 where table_schema = 'public' and table_name = 'ticket_comments'
   and column_name in ('moderation_status', 'moderation_reason',
                       'moderation_categories', 'moderation_severity',
                       'is_hidden', 'moderated_by', 'moderated_at', 'flagged_at')
union all
select 'new tables', count(*), 2
  from information_schema.tables
 where table_schema = 'public'
   and table_name in ('moderation_words', 'moderation_actions')
union all
select 'rls enabled', count(*), 2
  from pg_tables
 where schemaname = 'public'
   and tablename in ('moderation_words', 'moderation_actions')
   and rowsecurity = true
union all
select 'policies (must be 0)', count(*), 0
  from pg_policies
 where schemaname = 'public'
   and tablename in ('moderation_words', 'moderation_actions');
