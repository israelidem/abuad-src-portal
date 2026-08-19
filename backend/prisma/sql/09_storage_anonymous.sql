-- ============================================================
-- 09_storage_anonymous.sql
--
-- Closes a privacy leak in attachment paths for anonymous tickets.
--
-- Apply in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- THE PROBLEM
--
-- 02_storage.sql namespaces every upload under the uploader's user id:
--
--     <auth.uid()>/<random>.jpg
--
-- and the bucket is public-read, because the issue board is viewable
-- while logged out. For an identified ticket that is fine. For an
-- ANONYMOUS ticket it is not: the image URL is rendered to every viewer,
-- and its first path segment is the author's user id.
--
-- The ticket API is careful never to return `author` for an anonymous
-- ticket (see ticketService.js and the reveal endpoint in adminRoutes.js,
-- which demands a written reason and writes an audit row). A user id
-- sitting in an image URL defeats all of that — and worse, it is
-- correlatable: the same folder appears on that student's identified
-- uploads, so anyone can link an anonymous complaint to a named one.
--
-- THE FIX
--
-- Anonymous uploads go to an unguessable, single-use folder instead:
--
--     anon/<random-uuid>/<random-uuid>.jpg
--
-- Identified uploads are unchanged, keeping their owner-scoped write and
-- delete policies. This file adds the narrowest possible additional
-- write permission for the anon/ prefix.
--
-- THE TRADE-OFF, STATED PLAINLY
--
-- Under anon/, we cannot scope writes to an owner — that is the entire
-- point, since an owner-scoped path is what leaked. So any authenticated
-- user may insert under anon/. What that does and does not permit:
--
--   * Still restricted to authenticated users (role `authenticated`),
--     so anonymous internet traffic cannot write at all.
--   * Still bound by the bucket's file_size_limit and
--     allowed_mime_types, which Storage enforces regardless of policy.
--   * A user CANNOT overwrite someone else's anonymous attachment:
--     no UPDATE policy is granted on the prefix, and the client uploads
--     with upsert:false. Guessing a path would require guessing two
--     UUIDs.
--   * A user CANNOT delete another's anonymous attachment: no DELETE
--     policy is granted on the prefix either. Cleanup is a service-role
--     job, alongside the ticket deletion that already runs there.
--
-- The residual risk is a user uploading junk into anon/ they can then
-- neither read back usefully nor attach to a ticket (the API validates
-- attachment payloads against the submitting user's ticket). That is
-- rate-limited storage noise, not a data-exposure or integrity problem —
-- a materially better position than leaking author identity on every
-- anonymous submission.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Allow authenticated users to upload under anon/
--
-- The owner-scoped policy from 02_storage.sql stays exactly as it is;
-- this is additive. Postgres applies policies of the same command as
-- OR, so an upload is permitted if it is either owner-scoped or under
-- the anon/ prefix.
-- ------------------------------------------------------------
drop policy if exists "ticket_attachments_insert_anonymous" on storage.objects;
create policy "ticket_attachments_insert_anonymous"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'ticket-attachments'
    and (storage.foldername(name))[1] = 'anon'
    -- Require the full anon/<folder>/<file> shape. Without this a user
    -- could write directly to anon/whatever.jpg, and a predictable path
    -- in a public bucket invites overwrite attempts on a name someone
    -- else might later choose.
    and array_length(storage.foldername(name), 1) = 2
    -- And require the second segment to look like a UUID, so the
    -- unguessability the design depends on is enforced here rather than
    -- merely intended by the client.
    and (storage.foldername(name))[2] ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

-- ------------------------------------------------------------
-- 2. Deliberately NOT created
--
-- No UPDATE or DELETE policy for the anon/ prefix. Both would let one
-- student tamper with another's evidence, and neither is needed:
--   - uploads use upsert:false, so no overwrite is required;
--   - failed-submission cleanup and ticket deletion run service-side,
--     which bypasses RLS.
--
-- Recorded explicitly so a future reader does not "fix" the omission.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 3. Verify
-- ------------------------------------------------------------
select
  p.policyname,
  p.cmd,
  p.roles
from pg_policies p
where p.schemaname = 'storage'
  and p.tablename = 'objects'
  and p.policyname like 'ticket_attachments%'
order by p.cmd, p.policyname;

-- Expected: the four policies from 02_storage.sql plus
-- ticket_attachments_insert_anonymous (INSERT, {authenticated}).
--
-- Note on existing data: anonymous tickets submitted before this file
-- was applied still have <userId>/… attachment paths and remain
-- correlatable. Moving them would break the stored storage_path on
-- those rows, so it is not done automatically here. If the portal has
-- real anonymous submissions already, re-path them with a service-role
-- script that copies the object and updates attachments.storage_path in
-- the same transaction.
