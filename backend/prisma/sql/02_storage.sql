-- ============================================================
-- Storage: ticket attachments
--
-- Run this in the Supabase SQL Editor after 00_schema.sql and
-- 01_post_migration.sql. Safe to re-run — every statement is guarded.
--
-- The bucket name must stay 'ticket-attachments'; it's referenced
-- directly in frontend/src/lib/uploads.js.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The bucket
--
-- Public reads: attachments render as plain <img> tags, and signed
-- URLs would expire mid-session. Nothing sensitive should be posted
-- as an attachment — the description field is the private part.
--
-- The size and MIME limits are enforced by Storage itself, so a
-- crafted request can't bypass the checks in uploads.js.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ticket-attachments',
  'ticket-attachments',
  true,
  5242880, -- 5 MB, matching MAX_FILE_BYTES
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do update
  set file_size_limit   = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types,
      public             = excluded.public;

-- ------------------------------------------------------------
-- 2. Policies
--
-- Uploads are namespaced as <user-id>/<uuid>.<ext>, so comparing the
-- first path segment to auth.uid() confines each student to their own
-- folder. Without this, any signed-in user could overwrite another
-- person's evidence.
-- ------------------------------------------------------------
drop policy if exists "ticket_attachments_insert_own" on storage.objects;
create policy "ticket_attachments_insert_own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'ticket-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "ticket_attachments_update_own" on storage.objects;
create policy "ticket_attachments_update_own"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'ticket-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Covers the cleanup path in uploads.js when a submission fails
-- after its files have already uploaded.
drop policy if exists "ticket_attachments_delete_own" on storage.objects;
create policy "ticket_attachments_delete_own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'ticket-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Anyone may read: the public issue board is viewable while logged out.
drop policy if exists "ticket_attachments_read_public" on storage.objects;
create policy "ticket_attachments_read_public"
  on storage.objects for select to public
  using (bucket_id = 'ticket-attachments');

-- ------------------------------------------------------------
-- 3. Verify
-- ------------------------------------------------------------
select
  b.id                                as bucket,
  b.public,
  b.file_size_limit,
  (
    select count(*)
    from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname like 'ticket_attachments%'
  )                                   as policies_installed
from storage.buckets b
where b.id = 'ticket-attachments';

-- Expected: one row, public = true, file_size_limit = 5242880,
-- policies_installed = 4.
