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
 * Paths are namespaced by user so a Storage policy can restrict writes
 * to a caller's own folder.
 */
export const uploadAttachment = async (file, userId) => {
  const error = validateFile(file);
  if (error) throw new Error(error);

  const extension = file.name.split('.').pop()?.toLowerCase() ?? 'jpg';
  const path = `${userId}/${crypto.randomUUID()}.${extension}`;

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
