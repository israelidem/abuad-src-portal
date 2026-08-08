-- ============================================================
-- ABUAD SRC Portal — Add DEPARTMENT_CHANGED to TicketEventType
--
-- Re-routing a ticket to another department changed the record but wrote
-- no timeline entry, so the ticket silently moved office and the reporter
-- had no explanation for the handover.
--
-- Run against the DIRECT connection (not the pooler):
--   psql "$DIRECT_URL" -f prisma/sql/03_add_department_changed_event.sql
-- or paste into the Supabase SQL Editor.
--
-- Idempotent — safe to run more than once.
--
-- NOTE: `alter type ... add value` cannot run inside a transaction block
-- in Postgres. Run this file on its own, not wrapped in begin/commit.
-- `if not exists` requires Postgres 12+ (Supabase is well past that).
-- ============================================================

alter type "TicketEventType" add value if not exists 'DEPARTMENT_CHANGED';


-- ------------------------------------------------------------
-- Verify
-- ------------------------------------------------------------
-- Expect a row back. If this returns nothing, the enum value did not
-- apply and the API will throw on the next re-route.

select
  e.enumlabel as value,
  'DEPARTMENT_CHANGED is present' as status
from pg_enum e
join pg_type t on t.oid = e.enumtypid
where t.typname = 'TicketEventType'
  and e.enumlabel = 'DEPARTMENT_CHANGED';
