/**
 * Administrative audit trail.
 *
 * The `audit_logs` table and a local helper already existed in
 * adminRoutes.js, but three things limited it:
 *
 *   1. **Write-only.** Rows went in and nothing ever read them, so the
 *      trail could not answer a question without direct SQL access.
 *   2. **Route-local.** Only admin routes could reach the helper, so
 *      ticket status changes and assignments — the actions students
 *      actually dispute — were never recorded.
 *   3. **Silent on failure.** `catch {}` meant a broken audit write looked
 *      exactly like an action nobody had performed.
 *
 * The shape the brief asks for is Admin / Action / Target / Timestamp /
 * Previous value / New value. `changes()` below produces the last two as a
 * field-by-field diff, so "changed the ticket" becomes "changed status from
 * PENDING to IN_PROGRESS".
 *
 * Still deliberately non-fatal: an admin's action must not fail because
 * its audit row didn't write. The difference is that it now says so.
 */

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

/**
 * Fields that must never be written to the audit metadata.
 *
 * The trail is readable by admins, so it's a lower bar than the database
 * itself: recording a matric number in a diff would expose the identity
 * behind an anonymous ticket to anyone reading the log.
 */
const NEVER_RECORD = new Set([
  'password',
  'matricNumber',
  'matric_number',
  'authorId', // the anonymity link — traceable via the ticket row, not here
  'accessToken',
  'refreshToken',
]);

/**
 * Builds a `{ field: { from, to } }` diff of what actually changed.
 *
 * Only differing fields are included — a PATCH that sends the whole form
 * back would otherwise record thirty unchanged values and bury the one
 * that moved.
 *
 * Dates are normalised to ISO strings so that a Date and its serialised
 * form don't read as a change.
 */
export const changes = (before = {}, after = {}) => {
  const diff = {};

  for (const key of Object.keys(after)) {
    if (NEVER_RECORD.has(key)) continue;

    const normalise = (v) => (v instanceof Date ? v.toISOString() : v);
    const from = normalise(before?.[key]);
    const to = normalise(after[key]);

    if (from === to) continue;
    // Objects would need a deep compare; the fields worth auditing here
    // are all scalars, so anything else is skipped rather than guessed at.
    if (typeof to === 'object' && to !== null) continue;

    diff[key] = { from: from ?? null, to: to ?? null };
  }

  return Object.keys(diff).length ? diff : null;
};

/**
 * Records an administrative action.
 *
 * @param req          Express request — supplies actor, IP and request id.
 * @param action       Dotted verb, e.g. 'user.role_change'. Kept stable so
 *                     the trail stays filterable as the code changes.
 * @param entityType   'Profile' | 'Ticket' | 'AppSettings' | 'Department' …
 * @param entityId     Row the action targeted.
 * @param metadata     Free-form context; pass `changes(before, after)` for
 *                     a previous/new value diff.
 */
export const recordAudit = async (req, action, entityType, entityId, metadata) => {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: req.user?.id ?? null,
        action,
        entityType,
        entityId: entityId ?? null,
        metadata: metadata ?? undefined,
        ipAddress: req.ip,
      },
    });

    // Mirrored to the log so the action is visible in log search too, and
    // survives even if the row itself is later deleted.
    (req.log ?? logger).info(`audit.${action}`, {
      actorId: req.user?.id,
      entityType,
      entityId,
      ...(metadata ? { changes: metadata } : {}),
    });
  } catch (error) {
    // Non-fatal, but no longer invisible: a missing audit row is now
    // distinguishable from an action that never happened.
    (req.log ?? logger).error('audit.write_failed', {
      action,
      entityType,
      entityId,
      actorId: req.user?.id,
      err: error,
    });
  }
};
