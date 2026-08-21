/**
 * Cloudinary storage.
 *
 * ## Why signed direct uploads, and not a proxy through this API
 *
 * The obvious implementation — accept the file with multer, forward it to
 * Cloudinary — was rejected on measured grounds. The existing design has
 * the browser upload straight to Supabase Storage and send only the path
 * to the API; request bodies are capped at 1mb in server.js precisely
 * because files never pass through it.
 *
 * Proxying would mean 5MB bodies on a single-instance Render service:
 *
 *   - the body is buffered in memory, so 20 concurrent uploads is ~100MB
 *     of heap on a 512MB instance;
 *   - each upload occupies a connection for the duration of a mobile
 *     upstream transfer, which is seconds, not milliseconds;
 *   - it doubles bandwidth (client→API, API→Cloudinary) and puts a slow,
 *     unpredictable network call in the request path.
 *
 * Under the 2,500–5,000 concurrent-student load this work is meant to
 * survive, that is the first thing that would fall over. So the shape is
 * preserved: this module signs an upload, the browser sends the bytes
 * directly to Cloudinary, and only the resulting identifiers come back.
 *
 * ## What the signature is for
 *
 * A signed upload is not just authentication — the signature covers the
 * *parameters*, so the client cannot alter what it was authorised to do.
 * Folder, allowed formats, size limit and public_id are all signed, which
 * is what makes client-side validation non-bypassable: tampering with any
 * of them invalidates the signature and Cloudinary rejects the request.
 *
 * That matters because the alternative (an unsigned upload preset) would
 * let anyone who reads the JavaScript upload anything, at any size, to the
 * account — a bandwidth-and-storage billing attack with no login needed.
 */

import crypto from 'node:crypto';

import { env, isCloudinaryConfigured } from '../config/env.js';
import { logger } from '../lib/logger.js';

/** Formats accepted for attachments. */
export const ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];

/**
 * 5 MB, matching the existing Supabase limit and the frontend's
 * MAX_FILE_BYTES so the three cannot drift apart and produce a file the
 * client accepts and the server rejects.
 */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Signatures expire, so a leaked one is not reusable indefinitely. */
const SIGNATURE_TTL_SECONDS = 600; // 10 minutes

/**
 * Where a given kind of upload is allowed to go.
 *
 * An allowlist, not a caller-supplied string. If the client could name the
 * folder it could write anywhere in the account — including over another
 * user's namespace — so the API accepts a *kind* and maps it here.
 */
const FOLDERS = {
  ticket: 'tickets',
  feedback: 'feedback',
};

/**
 * Cloudinary's signature scheme: sort the parameters by key, join as
 * `k=v&k=v`, append the API secret, then SHA-1.
 *
 * Empty values are dropped because Cloudinary excludes them when it
 * recomputes the signature; including them produces a mismatch that
 * surfaces only as a generic 401 from the upload endpoint.
 */
export const signParams = (params, secret = env.cloudinary.apiSecret) => {
  const toSign = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');

  return crypto.createHash('sha1').update(toSign + secret).digest('hex');
};

/**
 * Builds a signed, single-use upload authorisation for the browser.
 *
 * @param kind    'ticket' | 'feedback' — selects the folder.
 * @param ownerId User id, or null for an anonymous submission.
 *
 * The anonymous case deliberately does NOT include the user id in the
 * path. The existing Supabase implementation documents why at length: the
 * bucket is public-read, so a path of `<userId>/photo.jpg` deanonymises
 * the author of an anonymous ticket to anyone who can see the URL. That
 * property must survive the migration, so anonymous uploads get a random
 * folder segment and identified ones keep the owner prefix.
 */
export const buildUploadSignature = ({ kind = 'ticket', ownerId = null } = {}) => {
  if (!isCloudinaryConfigured()) {
    throw new Error('Cloudinary is not configured');
  }

  const subfolder = FOLDERS[kind];
  if (!subfolder) throw new Error(`Unknown upload kind: ${kind}`);

  // Random segment for anonymous uploads — unguessable and single-use, so
  // it cannot be correlated back to a user or to a ticket's other files.
  const scope = ownerId ? `u/${ownerId}` : `anon/${crypto.randomUUID()}`;
  const folder = `${env.cloudinary.folder}/${subfolder}/${scope}`;

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = crypto.randomUUID();

  /**
   * Signed parameters. Every one of these is a constraint the client
   * cannot alter.
   *
   * `allowed_formats` is the important one: it makes Cloudinary reject a
   * PHP file renamed to .jpg, because the check is on the decoded content
   * rather than the filename. That is the malicious-upload defence — a
   * MIME-type check in JavaScript is trivially bypassed, and even a
   * server-side Content-Type check only sees what the client claims.
   */
  const params = {
    folder,
    public_id: publicId,
    timestamp,
    allowed_formats: ALLOWED_FORMATS.join(','),
    // Strips EXIF, including GPS coordinates. Students photograph hostel
    // and classroom problems on phones, and a geotagged image attached to
    // an "anonymous" complaint would locate the person who sent it.
    // Cheaper and more reliable than trying to scrub metadata ourselves.
    transformation: 'q_auto:good,fl_strip_profile',
    // Cloudinary enforces this server-side, so the 5MB limit is real
    // rather than advisory.
    max_bytes: MAX_FILE_BYTES,
    // A resource type of `image` refuses anything that does not decode as
    // an image, which is the second half of the malicious-upload defence.
    resource_type: 'image',
  };

  return {
    signature: signParams(params),
    timestamp,
    publicId,
    folder,
    // Not secrets — Cloudinary requires api_key in the upload body and
    // publishes cloud_name in every delivery URL. The secret stays here.
    apiKey: env.cloudinary.apiKey,
    cloudName: env.cloudinary.cloudName,
    allowedFormats: ALLOWED_FORMATS,
    maxBytes: MAX_FILE_BYTES,
    expiresAt: new Date((timestamp + SIGNATURE_TTL_SECONDS) * 1000).toISOString(),
    transformation: params.transformation,
  };
};

/**
 * Validates what the client claims it uploaded.
 *
 * The client reports the public_id after uploading, and a hostile client
 * could report anything — including a public_id belonging to a different
 * user's file, which would attach someone else's private image to a
 * ticket. So the returned id must sit inside the folder this server
 * authorised, and that folder contains either the caller's own user id or
 * a random segment the server generated.
 *
 * This is the IDOR guard for attachments. Without it, "storagePath" is
 * attacker-controlled and points anywhere in the account.
 */
export const isPublicIdWithinFolder = (publicId, folder) => {
  if (typeof publicId !== 'string' || typeof folder !== 'string') return false;
  if (!publicId || !folder) return false;

  // Reject traversal outright rather than trying to normalise it.
  if (publicId.includes('..')) return false;

  // Must be a direct child: `folder/<id>` and nothing deeper, so a
  // signature for one folder cannot be used to claim a nested path.
  const prefix = `${folder}/`;
  if (!publicId.startsWith(prefix)) return false;

  return !publicId.slice(prefix.length).includes('/');
};

/**
 * Delivery URL for a stored image.
 *
 * Built by string construction rather than an API call — Cloudinary URLs
 * are deterministic, and asking the API for something we can compute would
 * add a network round-trip to every attachment render.
 *
 * `f_auto` serves WebP/AVIF to browsers that accept them, and the width
 * cap keeps a 4000px phone photo from being sent at full size to a
 * mobile connection. Both matter for the load profile: attachments are
 * the largest thing the portal serves.
 */
export const buildDeliveryUrl = (publicId, { width = 1600, thumb = false } = {}) => {
  if (!publicId) return null;
  if (!env.cloudinary.cloudName) return null;

  const transform = thumb
    ? 'c_fill,w_320,h_320,g_auto,q_auto,f_auto'
    : `c_limit,w_${width},q_auto,f_auto`;

  return `https://res.cloudinary.com/${env.cloudinary.cloudName}/image/upload/${transform}/${publicId}`;
};

/**
 * Deletes an image.
 *
 * Uses the Admin API with a signed request. Returns a boolean rather than
 * throwing: callers delete during cleanup paths (a failed submission, a
 * removed ticket) where a storage failure must not roll back the database
 * operation the user actually asked for. An orphaned image costs a few
 * kilobytes; a failed ticket deletion is a bug the user sees.
 */
export const deleteImage = async (publicId) => {
  if (!isCloudinaryConfigured() || !publicId) return false;

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signParams({ public_id: publicId, timestamp });

  const body = new URLSearchParams({
    public_id: publicId,
    timestamp: String(timestamp),
    api_key: env.cloudinary.apiKey,
    signature,
  });

  try {
    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${env.cloudinary.cloudName}/image/destroy`,
      {
        method: 'POST',
        body,
        // Without a timeout a hung Cloudinary connection would hold the
        // request open indefinitely; deletion is best-effort, so bounding
        // it is strictly better than waiting.
        signal: AbortSignal.timeout(10_000),
      }
    );

    const result = await response.json();

    // 'not found' is success for our purposes: the desired end state is
    // "this image does not exist", and retrying would never change it.
    if (result.result === 'ok' || result.result === 'not found') return true;

    logger.warn('cloudinary.delete_unexpected', { publicId, result: result.result });
    return false;
  } catch (error) {
    logger.warn('cloudinary.delete_failed', {
      publicId,
      reason: error?.message?.split('\n')[0],
    });
    return false;
  }
};

/**
 * Deletes several images, tolerating individual failures.
 *
 * Sequential on purpose. Deleting 5 attachments in parallel saves perhaps
 * 200ms on a cleanup path nobody is waiting on, while making it possible
 * to hit Cloudinary's rate limit and lose all five.
 */
export const deleteImages = async (publicIds = []) => {
  let deleted = 0;
  for (const id of publicIds) {
    // eslint-disable-next-line no-await-in-loop
    if (await deleteImage(id)) deleted += 1;
  }
  return { requested: publicIds.length, deleted };
};

export { isCloudinaryConfigured };
