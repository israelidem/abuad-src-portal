/**
 * Attachment uploads.
 *
 * The old app read images with FileReader and posted them as base64 in
 * the request body — roughly 33% larger than the file, held in memory,
 * and stored in the database row. Files now go directly to Supabase
 * Storage and only the path is sent to the API.
 *
 * Validation here is a courtesy to the user; a Storage policy enforces
 * type and size limits server-side.
 */

import { supabase } from './supabase.js';

const BUCKET = 'ticket-attachments';

export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_FILES = 5;
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

export const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Returns an error message, or null when the file is acceptable. */
export const validateFile = (file) => {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return `${file.name} isn\u2019t a supported image (JPEG, PNG, WebP or HEIC).`;
  }
  if (file.size > MAX_FILE_BYTES) {
    return `${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_FILE_BYTES)}.`;
  }
  return null;
};

/**
 * Uploads one file and returns the attachment payload for the API.
 *
 * Paths are namespaced by user so a Storage policy can restrict writes to
 * a caller's own folder — `(storage.foldername(name))[1] = auth.uid()`
 * in 02_storage.sql.
 *
 * That namespacing is a privacy problem for anonymous tickets, though.
 * The bucket is public-read, so the URL of an attachment is visible to
 * anyone viewing the ticket — and a path of `<uuid>/photo.jpg` names the
 * author. Anyone could paste the folder segment into the profiles table
 * or simply compare it against a known user's other uploads, and the
 * anonymity the submission form promises would be gone. Worth noting the
 * ticket API is careful never to return `author` for anonymous tickets;
 * leaking it through an image URL would undo that work.
 *
 * So anonymous uploads go to a per-file random folder instead. The
 * trade-off is deliberate:
 *
 *   - identified uploads keep `<userId>/…`, so the owner-only write and
 *     delete policies still apply;
 *   - anonymous uploads land in `anon/<random>/…`, which the write policy
 *     must allow for any authenticated user (see 09_storage_anonymous.sql).
 *
 * The weaker write scope is acceptable because the path is unguessable
 * and single-use, and every write is still restricted to authenticated
 * users with the bucket's size and MIME limits enforced by Storage.
 * Deletion of anonymous attachments moves to the service role, which is
 * where ticket deletion already happens.
 */
export const uploadAttachment = async (file, userId, { anonymous = false } = {}) => {
  const error = validateFile(file);
  if (error) throw new Error(error);

  const extension = file.name.split('.').pop()?.toLowerCase() ?? 'jpg';

  // crypto.randomUUID twice for the anonymous case: one segment for the
  // folder, one for the file, so neither the folder nor the filename can
  // be correlated back to a user or to the ticket's other attachments.
  const path = anonymous
    ? `anon/${crypto.randomUUID()}/${crypto.randomUUID()}.${extension}`
    : `${userId}/${crypto.randomUUID()}.${extension}`;

  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  });

  if (uploadError) {
    throw new Error(`Could not upload ${file.name}: ${uploadError.message}`);
  }

  return {
    storagePath: path,
    mimeType: file.type,
    sizeBytes: file.size,
  };
};

/** Public URL for rendering a stored attachment. */
export const getAttachmentUrl = (storagePath) => {
  if (!storagePath) return null;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
};

/** Best-effort cleanup when a submission fails after uploading. */
export const removeAttachment = async (storagePath) => {
  try {
    await supabase.storage.from(BUCKET).remove([storagePath]);
  } catch {
    // An orphaned file is harmless; a lifecycle rule can sweep it up
  }
};
