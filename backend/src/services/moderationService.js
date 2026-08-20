/**
 * Comment moderation — the layer that connects the detection engine in
 * lib/textModeration.js to the database and the moderation queue.
 *
 * The engine is pure: text in, verdict out, no I/O. Everything that needs
 * a database lives here — loading the admin word list, deciding what a
 * verdict does to a comment, and writing the audit trail.
 *
 * WORD LIST CACHING
 *
 * The brief requires admin-added words to take effect without a deploy or
 * restart, so the list is read from the database rather than a constant.
 * A naive read would add a query to every comment POST, so it is cached
 * for CACHE_TTL_MS, matching the pattern already used by settingsService.
 *
 * The TTL is the tradeoff, stated plainly: a newly added word starts
 * applying within CACHE_TTL_MS on this instance. Adding a word through the
 * API also busts the cache immediately (see invalidateWordCache), so the
 * delay only affects *other* instances in a multi-instance deployment.
 * Seconds are acceptable for a blocklist; minutes would not be.
 *
 * FAILING OPEN
 *
 * If the word-list read fails, we fall back to the built-in list and keep
 * moderating rather than throwing. A student's comment must not be
 * rejected because a moderation table is unreachable — but neither should
 * a database blip silently disable all filtering, so the failure is
 * logged (throttled) with the fact that we are running degraded.
 */

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { analyseText, normaliseForMatching, collapseRuns } from '../lib/textModeration.js';
import { BUILTIN_WORDLIST, ALLOWLIST } from '../config/moderationWordlist.js';

const CACHE_TTL_MS = 30_000;

/** Moderation workflow states. Mirrors the SQL CHECK constraint. */
export const MODERATION_STATUS = Object.freeze({
  APPROVED: 'APPROVED',
  PENDING: 'PENDING',
  REJECTED: 'REJECTED',
  RESOLVED: 'RESOLVED',
});

/** Audit trail verbs. Mirrors the SQL CHECK constraint. */
export const MODERATION_ACTION = Object.freeze({
  AUTO_FLAGGED: 'AUTO_FLAGGED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  RESOLVED: 'RESOLVED',
  HIDDEN: 'HIDDEN',
  UNHIDDEN: 'UNHIDDEN',
});

let wordCache = null;
let wordCachedAt = 0;

let lastWarnedAt = 0;
const WARN_INTERVAL_MS = 60_000;

const warnWordListFailure = (error) => {
  if (Date.now() - lastWarnedAt < WARN_INTERVAL_MS) return;
  lastWarnedAt = Date.now();

  const drift =
    error?.meta?.code === '42P01' ||
    error?.meta?.code === '42703' ||
    /does not exist/i.test(error?.message ?? '');

  logger.error('moderation.wordlist_read_failed', {
    // The operationally important bit: filtering is still running, but
    // only on the built-in list. Admin-added terms are NOT being applied.
    servingFrom: wordCache ? 'stale cache' : 'built-in list only',
    reason: error?.message?.split('\n')[0],
    schemaDrift: drift,
    ...(drift
      ? {
          hint:
            'moderation_words is missing: the Prisma schema is ahead of the ' +
            'database. Admin-managed words are NOT being applied. Run ' +
            'backend/prisma/sql/10_comment_moderation.sql, then restart.',
        }
      : {}),
  });
};

/**
 * Normalises a term the same way the matcher does, so duplicate detection
 * agrees with detection. "Idiot", "idiot " and "  IDIOT" collapse to one
 * key; storing all three would let an admin fill the table with rows that
 * cannot ever match separately.
 *
 * The explicit trim matters and is not redundant: normaliseForMatching
 * lowercases and folds substitutions but preserves surrounding
 * whitespace, and collapseRuns only collapses repeated characters. A test
 * caught "  IDIOT  " surviving as a distinct key from "idiot", which
 * would have let the same word be stored twice — and stored a term whose
 * generated pattern carried stray padding.
 *
 * Internal runs are squeezed to single spaces too, so "kill    yourself"
 * and "kill yourself" are one entry rather than two.
 */
export const normaliseTerm = (term) =>
  collapseRuns(normaliseForMatching(String(term ?? '')))
    .replace(/\s+/g, ' ')
    .trim();


/**
 * Combined term list: built-in entries plus enabled admin entries.
 *
 * Built-ins stay in version control (reviewable, and not editable from a
 * compromised admin session). Admin rows are additive — an admin can add
 * and disable their own terms but cannot switch off a built-in, which
 * stops "disable every word" from being a one-click moderation bypass.
 */
export const getActiveTerms = async ({ force = false } = {}) => {
  const fresh = wordCache && Date.now() - wordCachedAt < CACHE_TTL_MS;
  if (fresh && !force) return wordCache;

  try {
    const rows = await prisma.moderationWord.findMany({
      where: { isEnabled: true },
      // Bounded deliberately. An unbounded findMany here would be a slow
      // query on every cache miss if the table ever grew large, and a
      // blocklist beyond this size is a sign of misuse, not of need.
      take: 2000,
      select: { term: true, category: true, severity: true },
    });

    wordCache = [...BUILTIN_WORDLIST, ...rows];
    wordCachedAt = Date.now();
    return wordCache;
  } catch (error) {
    warnWordListFailure(error);
    // Fail open onto the built-in list: degraded, not disabled.
    return wordCache ?? BUILTIN_WORDLIST;
  }
};

/** Called after any word-list write so the change applies immediately. */
export const invalidateWordCache = () => {
  wordCache = null;
  wordCachedAt = 0;
};

/** Exposed for tests. */
export const _wordCacheState = () => ({ cached: wordCache !== null, size: wordCache?.length ?? 0 });

/**
 * Runs the filter over a comment body.
 *
 * Returns the fields to persist on the comment, so the caller does not
 * have to know how a verdict maps onto columns. A clean comment gets
 * APPROVED with no reason — the common case, and deliberately the cheapest.
 */
export const evaluateComment = async (body, { terms: override = null } = {}) => {
  // `override` exists so the mapping from verdict to columns can be tested
  // without a database. Production callers never pass it.
  const terms = override ?? (await getActiveTerms());
  const verdict = analyseText(body, { terms, allowlist: ALLOWLIST });


  if (!verdict.flagged) {
    return {
      flagged: false,
      fields: {
        moderationStatus: MODERATION_STATUS.APPROVED,
        moderationReason: null,
        moderationCategories: [],
        moderationSeverity: null,
        isHidden: false,
        flaggedAt: null,
      },
      verdict,
    };
  }

  return {
    flagged: true,
    fields: {
      moderationStatus: MODERATION_STATUS.PENDING,
      moderationReason: verdict.reason,
      moderationCategories: verdict.categories,
      moderationSeverity: verdict.severity,
      // Hide only what the engine judged severe enough to warrant it.
      // Queueing without hiding is the default so a false positive does
      // not censor a legitimate complaint while it waits for review.
      isHidden: verdict.hidden,
      flaggedAt: new Date(),
    },
    verdict,
  };
};

/**
 * Records a moderation action.
 *
 * Best-effort: a failure to write history must not roll back the
 * moderation decision itself, which is the thing the moderator asked for.
 * Failures are logged rather than thrown, mirroring auditService.
 */
export const recordModerationAction = async ({
  commentId,
  actorId = null,
  actorRole = null,
  action,
  reason = null,
  fromStatus = null,
  toStatus = null,
}) => {
  try {
    await prisma.moderationAction.create({
      data: { commentId, actorId, actorRole, action, reason, fromStatus, toStatus },
    });
  } catch (error) {
    logger.error('moderation.audit_write_failed', {
      commentId,
      action,
      reason: error?.message?.split('\n')[0],
    });
  }
};

/**
 * Whether a viewer may see a comment that moderation has hidden.
 *
 * Staff can, so they can moderate in context. The author can see their own
 * — hiding it from them too produces "my comment vanished" support tickets
 * and teaches nothing. Everyone else does not.
 */
export const canSeeHiddenComment = (comment, viewer) => {
  if (!viewer) return false;
  if (viewer.role === 'REP' || viewer.role === 'ADMIN' || viewer.role === 'SUPER_ADMIN') return true;
  return comment.authorId === viewer.id;
};
