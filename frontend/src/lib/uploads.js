/**
 * Attachment uploads — Cloudinary.
 *
 * ## History
 *
 * The original app read images with FileReader and posted them as base64
 * in the request body: ~33% larger than the file, held in memory, stored
 * in the database row. That was replaced by direct-to-Supabase-Storage
 * uploads, sending only the path to the API. This module keeps that shape
 * and swaps the destination to Cloudinary.
 *
 * ## Why the interface is unchanged
 *
 * `uploadAttachment`, `getAttachmentUrl`, `removeAttachment`,
 * `validateFile`, `MAX_FILE_BYTES`, `MAX_FILES`, `ACCEPTED_TYPES` and
 * `formatBytes` all keep their previous signatures, and `uploadAttachment`
 * still resolves to `{ storagePath, mimeType, sizeBytes }`.
 *
 * That is deliberate. AttachmentPicker, NewTicket and TicketDetail consume
 * these, the backend's ticketSchemas validator expects `storagePath`, and
 * the `ticket_attachments.storage_path` column already holds Supabase
 * paths for existing rows. Renaming the field would mean a schema change,
 * a validator change, a data migration and edits to three components — for
 * no behavioural gain. `storagePath` now holds a Cloudinary public_id
 * instead of a bucket path; it is still "the identifier for the stored
 * object", which is all the callers ever treated it as.
 *
 * ## Credentials
 *
 * No Cloudinary key or secret appears in this file or anywhere in the
 * bundle. The browser asks the API for a signature, and the API signs with
 * a server-only secret. The signature covers folder, allowed formats and
 * max size, so the validation below is a courtesy to the user — Cloudinary
 * enforces the same limits and rejects anything that disagrees.
 */

import { api } from './api.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_FILES = 5;
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

/**
 * Cloud name for building delivery URLs.
 *
 * Not a secret — Cloudinary publishes it in every delivery URL, and it
 * cannot authorise an upload on its own. Read from the Vite env so the
 * value is not hardcoded per environment.
 */
const CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME ?? '';

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
 * Two steps: ask our API to authorise the upload, then send the bytes
 * straight to Cloudinary. The file never passes through our server — see
 * cloudinaryService.js for why that matters under load.
 *
 * The anonymity property from the Supabase implementation is preserved.
 * Delivery URLs are public, so a path containing the uploader's id would
 * deanonymise the author of an anonymous ticket to anyone who can see the
 * image. `anonymous: true` makes the server issue a signature for a random
 * folder with no user id in it.
 */
export const uploadAttachment = async (file, userId, { anonymous = false } = {}) => {
  const error = validateFile(file);
  if (error) throw new Error(error);

  // Step 1: authorisation. Fails closed — no signature, no upload.
  let auth;
  try {
    auth = await api.post('/api/uploads/signature', { kind: 'ticket', anonymous });
  } catch (err) {
    // 503 means Cloudinary is not configured on the server. Say something
    // the user can act on instead of surfacing a raw status code.
    if (err?.status === 503) {
      throw new Error('Image uploads are temporarily unavailable. You can submit without a photo.');
    }
    if (err?.status === 429) {
      throw new Error('Too many uploads just now. Please wait a moment and try again.');
    }
    throw new Error(`Could not start upload for ${file.name}. Please try again.`);
  }

  // Step 2: the bytes. Every signed field must be sent back exactly as
  // issued — Cloudinary recomputes the signature over them and rejects the
  // upload if any value was altered, which is what makes the folder, size
  // and format limits non-bypassable from here.
  const form = new FormData();
  form.append('file', file);
  form.append('api_key', auth.apiKey);
  form.append('timestamp', auth.timestamp);
  form.append('signature', auth.signature);
  form.append('folder', auth.folder);
  form.append('public_id', auth.publicId);
  form.append('allowed_formats', auth.allowedFormats.join(','));
  form.append('transformation', auth.transformation);
  form.append('max_bytes', auth.maxBytes);

  let response;
  try {
    response = await fetch(
      `https://api.cloudinary.com/v1_1/${auth.cloudName}/image/upload`,
      { method: 'POST', body: form }
    );
  } catch {
    // Network-level failure: offline, DNS, connection dropped mid-transfer.
    // Nothing was stored, so there is nothing to clean up.
    throw new Error(`Could not upload ${file.name}. Check your connection and try again.`);
  }

  if (!response.ok) {
    // Cloudinary reports the reason in JSON; surface it only if it is
    // useful, since the messages are aimed at developers.
    let reason = '';
    try {
      const body = await response.json();
      reason = body?.error?.message ?? '';
    } catch {
      // Non-JSON error body — nothing to extract.
    }

    if (/file size|too large|max_bytes/i.test(reason)) {
      throw new Error(`${file.name} is too large — the limit is ${formatBytes(MAX_FILE_BYTES)}.`);
    }
    if (/format|invalid image|unsupported/i.test(reason)) {
      throw new Error(`${file.name} isn\u2019t a valid image file.`);
    }
    throw new Error(`Could not upload ${file.name}. Please try again.`);
  }

  const result = await response.json();

  return {
    // Cloudinary's public_id, in the same field the API and database
    // already use for a stored-object identifier.
    storagePath: result.public_id,
    mimeType: file.type,
    // The size Cloudinary actually stored, which differs from file.size
    // because the signed transformation re-encodes and strips metadata.
    // Recording the claimed size would make the number wrong.
    sizeBytes: result.bytes ?? file.size,
  };
};

/**
 * Delivery URL for a stored attachment.
 *
 * Built by string construction — Cloudinary URLs are deterministic, so an
 * API call to fetch something computable would add a round-trip per image.
 *
 * `f_auto` serves WebP/AVIF where supported and `w_1600` caps a 4000px
 * phone photo, which matters because attachments are the largest thing the
 * portal sends to mobile connections.
 *
 * Backwards compatibility: rows created before this migration hold Supabase
 * paths, not Cloudinary ids. Those are detected and served from Supabase so
 * existing tickets keep rendering — see STORAGE_MIGRATION.md.
 */
export const getAttachmentUrl = (storagePath, { thumb = false } = {}) => {
  if (!storagePath) return null;

  if (isLegacySupabasePath(storagePath)) {
    return legacySupabaseUrl(storagePath);
  }

  if (!CLOUD_NAME) return null;

  const transform = thumb
    ? 'c_fill,w_320,h_320,g_auto,q_auto,f_auto'
    : 'c_limit,w_1600,q_auto,f_auto';

  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${transform}/${storagePath}`;
};

/**
 * Distinguishes a pre-migration Supabase path from a Cloudinary public_id.
 *
 * Supabase paths always end in a file extension (`<uuid>/<uuid>.jpg`),
 * because the extension was part of the object name. Cloudinary public_ids
 * as issued by buildUploadSignature are bare UUIDs under a folder, with the
 * format stored as separate metadata — so a trailing image extension is a
 * reliable marker of the old scheme.
 */
const isLegacySupabasePath = (path) => /\.(jpe?g|png|webp|heic|heif)$/i.test(path);

/** Public URL for an attachment still stored in Supabase Storage. */
const legacySupabaseUrl = (path) => {
  const base = import.meta.env.VITE_SUPABASE_URL;
  if (!base) return null;
  return `${base}/storage/v1/object/public/ticket-attachments/${path}`;
};

/**
 * Best-effort cleanup when a submission fails after uploading.
 *
 * Deletion goes through our API, never directly to Cloudinary: destroying
 * an image requires the API secret, and shipping that to the browser would
 * let anyone delete any image in the account.
 *
 * Swallows failures by design. This runs when the user's submission has
 * already failed, and a second error message about storage would be noise.
 * An orphaned image costs a few kilobytes.
 */
export const removeAttachment = async (storagePath) => {
  if (!storagePath) return;
  try {
    await api.delete(`/api/uploads/${encodeURIComponent(storagePath)}`);
  } catch {
    // Orphan left behind; harmless, and sweepable later.
  }
};
