/**
 * Flagged comment queue.
 *
 * The automatic filter has been writing PENDING rows since migration 10, but
 * nothing rendered them — so every flag was, again, a note to nobody. This is
 * the review surface for those rows.
 *
 * Kept separate from the flagged *ticket* list even though both live under
 * "Moderation": tickets are flagged by a human who chose to escalate, comments
 * by a filter that can be wrong. The decisions differ accordingly — the most
 * common action here is "approve", i.e. the filter made a mistake.
 *
 * Comment bodies are rendered as text, never as HTML. Interpolating them into
 * markup would hand every student a stored-XSS vector aimed squarely at the
 * one page only admins open.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, EyeOff, MessageSquareWarning, ShieldCheck, XCircle } from 'lucide-react';

import { adminApi } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { Spinner } from './Spinner.jsx';

/// Mirrors MODERATION_STATUS on the server. PENDING first because it is the
/// only tab with outstanding work.
const TABS = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'REJECTED', label: 'Removed' },
  { value: 'APPROVED', label: 'Approved' },
];

const SEVERITY_STYLES = {
  high: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  low: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

export default function FlaggedComments() {
  const toast = useToast();

  const [status, setStatus] = useState('PENDING');
  const [page, setPage] = useState(1);
  const [comments, setComments] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  /// Comment id whose removal reason is being typed, and the text.
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');

  const load = useCallback(
    async (signal) => {
      setLoading(true);
      try {
        const data = await adminApi.moderationComments({ status, page }, { signal });
        setComments(data.comments);
        setPagination(data.pagination);
        setError('');
      } catch (err) {
        if (err.name === 'AbortError') return;
        setError(err.displayMessage ?? err.message);
      } finally {
        setLoading(false);
      }
    },
    [status, page]
  );

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const decide = async (comment, action, withReason) => {
    setBusyId(comment.id);
    try {
      await adminApi.decideComment(comment.id, action, withReason);

      // The row no longer belongs in this tab, so drop it locally instead of
      // refetching. The count is adjusted with it, otherwise the pager would
      // claim a total the list no longer matches.
      setComments((prev) => prev.filter((c) => c.id !== comment.id));
      setPagination((prev) => (prev ? { ...prev, total: Math.max(0, prev.total - 1) } : prev));

      setRejecting(null);
      setReason('');
      toast.success(
        {
          approve: 'Comment approved and visible.',
          reject: 'Comment removed.',
          resolve: 'Marked as resolved.',
        }[action]
      );
    } catch (err) {
      toast.error(err.displayMessage ?? err.message);
    } finally {
      setBusyId(null);
    }
  };

  const submitReject = (event, comment) => {
    event.preventDefault();
    decide(comment, 'reject', reason);
  };

  const switchTab = (value) => {
    setStatus(value);
    setPage(1); // page 3 of Pending is rarely page 3 of Resolved
    setRejecting(null);
    setReason('');
  };

  return (
    <div>
      {/* Tabs are real buttons in a tablist so arrow-key/tab navigation and
          screen-reader announcement come for free. */}
      <div
        role="tablist"
        aria-label="Moderation status"
        className="mb-4 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800"
      >
        {TABS.map((tab) => {
          const active = status === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => switchTab(tab.value)}
              className={`-mb-px min-h-11 rounded-t-lg border-b-2 px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006633] focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-900 ${
                active
                  ? 'border-[#006633] text-[#006633] dark:border-green-400 dark:text-green-400'
                  : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {tab.label}
              {active && pagination ? ` (${pagination.total})` : ''}
            </button>
          );
        })}
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {/* aria-busy lets assistive tech know the region is updating rather
          than empty, which is otherwise indistinguishable. */}
      <div aria-busy={loading} aria-live="polite">
        {loading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : comments.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-10 text-center dark:border-slate-800 dark:bg-slate-900">
            <ShieldCheck size={32} className="mx-auto mb-3 text-green-600" aria-hidden="true" />
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
              {status === 'PENDING' ? 'No comments awaiting review.' : 'Nothing here.'}
            </p>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {status === 'PENDING'
                ? 'Comments caught by the filter appear here for review.'
                : 'Decisions you make will be listed under their outcome.'}
            </p>
          </div>
        ) : (
          <ul className="space-y-4">
            {comments.map((comment) => {
              const busy = busyId === comment.id;

              return (
                <li
                  key={comment.id}
                  className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    {comment.ticket && (
                      <Link
                        to={`/tickets/${comment.ticket.id}`}
                        className="rounded font-mono text-sm font-semibold text-[#006633] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006633] dark:text-green-400"
                      >
                        {comment.ticket.ticketNumber}
                      </Link>
                    )}

                    {comment.moderationSeverity && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          SEVERITY_STYLES[comment.moderationSeverity] ?? SEVERITY_STYLES.low
                        }`}
                      >
                        {comment.moderationSeverity} severity
                      </span>
                    )}

                    {comment.isHidden && (
                      <span className="flex items-center gap-1 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-white dark:bg-slate-700">
                        <EyeOff size={11} aria-hidden="true" />
                        Hidden
                      </span>
                    )}

                    {comment.isInternal && (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-950/60 dark:text-blue-300">
                        Internal note
                      </span>
                    )}
                  </div>

                  {/* Why the filter stopped it. Staff-only: this is never
                      returned to the comment's author, who would otherwise
                      learn exactly which term to avoid next time. */}
                  {comment.moderationReason && (
                    <p className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                      <span className="font-medium">Flagged:</span> {comment.moderationReason}
                      {comment.moderationCategories?.length > 0 && (
                        <span className="ml-1 text-xs opacity-80">
                          ({comment.moderationCategories.join(', ')})
                        </span>
                      )}
                    </p>
                  )}

                  {/* The comment itself, quoted as plain text. */}
                  <blockquote className="mb-3 border-l-2 border-slate-200 pl-3 text-sm whitespace-pre-wrap break-words text-slate-700 dark:border-slate-700 dark:text-slate-300">
                    {comment.body}
                  </blockquote>

                  <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                    {/* author is null when the parent ticket is anonymous —
                        the queue must not become a way around the audited
                        reveal step. */}
                    {comment.author ? comment.author.fullName : 'Anonymous'}
                    {' · '}
                    {formatDate(comment.flaggedAt ?? comment.createdAt)}
                    {comment.moderatedBy && (
                      <>
                        {' · reviewed by '}
                        {comment.moderatedBy.fullName}
                        {comment.moderatedAt ? ` on ${formatDate(comment.moderatedAt)}` : ''}
                      </>
                    )}
                  </p>

                  {rejecting === comment.id ? (
                    <form onSubmit={(e) => submitReject(e, comment)} className="mb-3 space-y-2">
                      <label
                        htmlFor={`reject-reason-${comment.id}`}
                        className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                      >
                        Why is this comment being removed?
                      </label>
                      <textarea
                        id={`reject-reason-${comment.id}`}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        rows={2}
                        required
                        minLength={5}
                        maxLength={500}
                        placeholder="e.g. Targeted abuse of a named student."
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                      />
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Your name, the reason and the time are recorded permanently.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="submit"
                          disabled={busy}
                          className="min-h-11 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-60"
                        >
                          Confirm removal
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRejecting(null);
                            setReason('');
                          }}
                          className="min-h-11 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium dark:border-slate-700 dark:text-slate-200"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                      {/* Approve is first and visually lightest: the filter
                          is fallible, and clearing a false positive should be
                          the easiest thing on this screen. */}
                      <button
                        type="button"
                        onClick={() => decide(comment, 'approve')}
                        disabled={busy}
                        className="flex min-h-11 items-center gap-1.5 rounded-lg border border-green-300 px-3 py-1.5 text-xs font-medium text-green-800 hover:bg-green-50 disabled:opacity-60 dark:border-green-900/60 dark:text-green-400 dark:hover:bg-green-950/30"
                      >
                        <CheckCircle2 size={14} aria-hidden="true" />
                        Approve
                      </button>

                      <button
                        type="button"
                        onClick={() => setRejecting(comment.id)}
                        disabled={busy}
                        className="flex min-h-11 items-center gap-1.5 rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/30"
                      >
                        <XCircle size={14} aria-hidden="true" />
                        Remove
                      </button>

                      <button
                        type="button"
                        onClick={() => decide(comment, 'resolve')}
                        disabled={busy}
                        className="flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        <ShieldCheck size={14} aria-hidden="true" />
                        Mark resolved
                      </button>

                      {comment.ticket && (
                        <Link
                          to={`/tickets/${comment.ticket.id}`}
                          className="flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          <MessageSquareWarning size={14} aria-hidden="true" />
                          See in context
                        </Link>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Pager. Only rendered when there is more than one page — a lone
          "Page 1 of 1" is noise. */}
      {pagination && pagination.totalPages > 1 && (
        <nav
          aria-label="Flagged comment pages"
          className="mt-6 flex items-center justify-between gap-3"
        >
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            className="min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
          >
            Previous
          </button>
          <span className="text-sm text-slate-600 dark:text-slate-400">
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
            disabled={page >= pagination.totalPages || loading}
            className="min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}
