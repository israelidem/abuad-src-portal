/**
 * Upload authorisation.
 *
 * One endpoint: it hands the browser a signed, short-lived, tightly scoped
 * permission to upload a single image directly to Cloudinary. The bytes
 * never touch this server — see the rationale in cloudinaryService.js.
 *
 * Security properties, in order of importance:
 *
 *   1. Authentication required. An unauthenticated caller cannot obtain a
 *      signature, so the account's storage and bandwidth are not open to
 *      the internet. This is the difference between signed uploads and an
 *      unsigned preset, and the reason for the former.
 *   2. Rate limited per user. A valid account is still capable of
 *      requesting thousands of signatures; uploadLimiter bounds that.
 *   3. The folder is chosen by the server. The client sends a `kind`, not a
 *      path, so it cannot direct writes into another user's namespace.
 *   4. The signature covers format, size and folder, so client-side
 *      validation is not the enforcement point — Cloudinary is.
 */

import express from 'express';

import { requireAuth } from '../middleware/auth.js';
import { uploadLimiter } from '../middleware/rateLimiter.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ApiError } from '../utils/ApiError.js';
import {
  buildUploadSignature,
  isCloudinaryConfigured,
  deleteImage,
} from '../services/cloudinaryService.js';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';

const router = express.Router();

/**
 * POST /api/uploads/signature
 *
 * Body: { kind?: 'ticket' | 'feedback', anonymous?: boolean }
 */
router.post(
  '/signature',
  requireAuth,
  uploadLimiter,
  asyncHandler(async (req, res) => {
    if (!isCloudinaryConfigured()) {
      // 503, not 500: this is a deployment configuration gap, not a bug,
      // and the distinction tells whoever is on call what to do about it.
      throw new ApiError(
        503,
        'Attachment uploads are temporarily unavailable. Please submit without an image.'
      );
    }

    const { kind = 'ticket', anonymous = false } = req.body ?? {};

    if (kind !== 'ticket' && kind !== 'feedback') {
      throw new ApiError(400, 'Unsupported upload kind.');
    }

    /**
     * `anonymous` is honoured but never trusted as an identity claim.
     *
     * It only decides whether the caller's id appears in the storage path.
     * A user asking for an anonymous path gets one — that is the whole
     * point, and it cannot be used to impersonate anyone, because the
     * resulting folder is random rather than another user's.
     *
     * The inverse would be a real vulnerability: letting the client send
     * an arbitrary ownerId would allow writing into someone else's folder.
     * Hence req.user.id, never a body field.
     */
    const signature = buildUploadSignature({
      kind,
      ownerId: anonymous === true ? null : req.user.id,
    });

    // Log without the signature itself. It is short-lived and scoped, but
    // it is still a credential, and logs are the wrong place for one.
    req.log.info('upload.signature_issued', {
      kind,
      anonymous: anonymous === true,
      folder: signature.folder,
    });

    res.json(signature);
  })
);

/**
 * DELETE /api/uploads/:publicId
 *
 * Cleanup for an image that was uploaded but never attached to anything —
 * the user picked a photo, the upload succeeded, then the ticket submission
 * failed or they removed the photo before submitting.
 *
 * ## Why this endpoint needs an ownership check
 *
 * Deletion requires the Cloudinary API secret, so it cannot happen in the
 * browser; it has to be proxied. But a naive proxy is a destructive IDOR:
 * any authenticated student could delete every image in the account by
 * enumerating public_ids. So the caller must prove the image is theirs.
 *
 * Three cases, in order of checking:
 *
 *   1. The path contains the caller's own user id (`.../u/<uid>/<file>`).
 *      Direct ownership — allow.
 *   2. The path is an anonymous upload (`.../anon/<random>/<file>`). There
 *      is no owner recorded anywhere, by design, so ownership cannot be
 *      proven. Knowledge of two unguessable UUIDs is treated as proof of
 *      possession — the same reasoning the Supabase policy used, and the
 *      only option that does not either break anonymous cleanup or record
 *      the association that anonymity exists to avoid.
 *   3. Anything else — refuse.
 *
 * ## Why an attached image cannot be deleted here
 *
 * Once a row in ticket_attachments references the image, deleting it would
 * leave a broken image on someone's ticket, and a student could use this to
 * strip evidence from a complaint after staff had seen it. Attached images
 * are removed only when the ticket itself is deleted. So this endpoint
 * refuses if the image is referenced, which also makes it safe to call
 * blindly from a failed-submission cleanup path.
 */
router.delete(
  '/:publicId(*)',
  requireAuth,
  uploadLimiter,
  asyncHandler(async (req, res) => {
    // `(*)` because a public_id contains slashes, which a normal route
    // parameter would not capture.
    const publicId = req.params.publicId;

    if (!publicId || publicId.includes('..')) {
      throw new ApiError(400, 'Invalid image reference.');
    }

    // Must live under this deployment's folder. Prevents a caller reaching
    // other content in a shared Cloudinary account.
    if (!publicId.startsWith(`${env.cloudinary.folder}/`)) {
      throw new ApiError(403, 'Not permitted.');
    }

    const ownsPath = publicId.includes(`/u/${req.user.id}/`);
    const isAnonPath = /\/anon\/[0-9a-f-]{36}\//i.test(publicId);

    if (!ownsPath && !isAnonPath) {
      // 403 with no detail. Confirming "that image exists but isn't yours"
      // would turn this into an enumeration oracle.
      throw new ApiError(403, 'Not permitted.');
    }

    // Refuse if the image is attached to a ticket (see above).
    const attached = await prisma.ticketAttachment.findFirst({
      where: { storagePath: publicId },
      select: { id: true },
    });

    if (attached) {
      throw new ApiError(409, 'This image is attached to a ticket and cannot be removed here.');
    }

    const deleted = await deleteImage(publicId);

    req.log.info('upload.deleted', { publicId, deleted, anonymous: isAnonPath && !ownsPath });

    // 200 even when Cloudinary reported a failure. The caller is a
    // best-effort cleanup path that cannot act on the difference, and the
    // orphan is logged above for a later sweep.
    res.json({ deleted });
  })
);

export default router;
