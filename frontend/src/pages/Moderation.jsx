/**
 * Moderation queue.
 *
 * Flagging a ticket already worked, but nothing ever listed the flagged
 * ones — so a flag was a note to nobody. This is that list, plus the two
 * decisions an admin can actually make about it: clear the flag, or take
 * the ticket down.
 *
 * Revealing an anonymous author lives here too, behind a written reason.
 * The submission form promises students that anonymity holds "except for
 * serious abuse"; this is the only door through which that exception is
 * available, and it writes an audit row on the way through.
 *
 * Three sections, because there are three genuinely different jobs: reports
 * escalated by a human, comments caught by the automatic filter, and the
 * blocklist that filter reads from. They were merged into one list at first
 * and it read as a single undifferentiated pile of work.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Eye, ShieldCheck, Trash2, UserSearch } from 'lucide-react';

import { adminApi, ticketApi } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { CATEGORIES } from '../lib/constants.js';
import { Spinner } from '../components/Spinner.jsx';
import FlaggedComments from '../components/FlaggedComments.jsx';
import ModerationWords from '../components/ModerationWords.jsx';

const VIEWS = [
  { value: 'reports', label: 'Flagged reports' },
  { value: 'comments', label: 'Flagged comments' },
  { value: 'words', label: 'Blocked words' },
];

export default function Moderation() {
  const toast = useToast();

  const [view, setView] = useState('reports');

  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  /// Ticket id currently being revealed, and the typed justification.
  const [revealing, setRevealing] = useState(null);
  const [reason, setReason] = useState('');

  /// Revealed identities, keyed by ticket id. Deliberately not persisted:
  /// a name shown once shouldn't linger on screen after a refresh.
  const [revealed, setRevealed] = useState({});

  const load = useCallback(
    async (signal) => {
      try {
        const data = await adminApi.moderation({ signal });
        setTickets(data.tickets);
        setError('');
      } catch (err) {
        if (err.name === 'AbortError') return;
        setError(err.displayMessage ?? err.message);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    const controller = new AbortController();
    // Fetch-on-mount. The rule guards against cascading renders, but the
    // queue has to come from the server before anything can be shown,
    // and the request is aborted on unmount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const unflag = async (ticket) => {
    setBusyId(ticket.id);
    try {
      await ticketApi.flag(ticket.id, false);
      // Drop it locally rather than refetching — the row is leaving the
      // queue either way, and the list is short.
      setTickets((prev) => prev.filter((t) => t.id !== ticket.id));
      toast.success(`${ticket.ticketNumber} cleared.`);
    } catch (err) {
      toast.error(err.displayMessage ?? err.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (ticket) => {
    // Deletion cascades to comments, votes and attachments, so it is not
    // something to trigger from a single stray click.
    if (
      !window.confirm(
        `Delete ${ticket.ticketNumber}? This also removes its comments, votes and photos, and cannot be undone.`
      )
    ) {
      return;
    }

    setBusyId(ticket.id);
    try {
      await ticketApi.remove(ticket.id);
      setTickets((prev) => prev.filter((t) => t.id !== ticket.id));
      toast.success(`${ticket.ticketNumber} deleted.`);
    } catch (err) {
      toast.error(err.displayMessage ?? err.message);
    } finally {
      setBusyId(null);
    }
  };

  const submitReveal = async (event, ticket) => {
    event.preventDefault();
    setBusyId(ticket.id);
    try {
      const { author } = await adminApi.revealAuthor(ticket.id, reason);
      setRevealed((prev) => ({ ...prev, [ticket.id]: author }));
      setRevealing(null);
      setReason('');
      toast.success('Author revealed. This action has been logged.');
    } catch (err) {
      toast.error(err.displayMessage ?? err.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-4xl py-4">
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-semibold text-slate-900 dark:text-white">
        <AlertTriangle size={22} className="text-amber-500" aria-hidden="true" />
        Moderation
      </h1>
      <p className="mb-4 text-sm text-slate-600 dark:text-slate-400">
        {view === 'reports' &&
          'Reports flagged by staff. Clear the flag if it was raised in error, or remove the report if it breaks the rules.'}
        {view === 'comments' &&
          'Comments the automatic filter stopped. The filter is not infallible — approve anything it caught by mistake.'}
        {view === 'words' && 'Words and phrases the filter blocks, in addition to the built-in list.'}
      </p>

      {/* Section switcher. Each section owns its own loading and error state,
          so switching away from a slow request does not blank the page. */}
      <div
        role="tablist"
        aria-label="Moderation sections"
        className="mb-6 flex flex-wrap gap-2"
      >
        {VIEWS.map((v) => {
          const active = view === v.value;
          return (
            <button
              key={v.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setView(v.value)}
              className={`min-h-11 rounded-lg px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006633] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900 ${
                active
                  ? 'bg-[#006633] text-white'
                  : 'border border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800'
              }`}
            >
              {v.label}
            </button>
          );
        })}
      </div>

      {view === 'comments' && <FlaggedComments />}
      {view === 'words' && <ModerationWords />}

      {view === 'reports' && (
        <>
          {loading ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : (
            <>
              {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </div>
      )}

              {tickets.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center dark:border-slate-800 dark:bg-slate-900">
          <ShieldCheck size={32} className="mx-auto mb-3 text-green-600" aria-hidden="true" />
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
            Nothing to review.
          </p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Flagged reports will appear here.
          </p>
        </div>
      ) : (
        <ul className="space-y-4">
          {tickets.map((ticket) => {
            const busy = busyId === ticket.id;
            const identity = revealed[ticket.id];

            return (
              <li
                key={ticket.id}
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Link
                    to={`/tickets/${ticket.id}`}
                    className="font-mono text-sm font-semibold text-[#006633] hover:underline dark:text-green-400"
                  >
                    {ticket.ticketNumber}
                  </Link>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {CATEGORIES[ticket.category]?.label ?? ticket.category}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {ticket.status}
                  </span>
                  {ticket.isAnonymous && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                      Anonymous
                    </span>
                  )}
                </div>

                {ticket.flagReason && (
                  <p className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                    <span className="font-medium">Flagged:</span> {ticket.flagReason}
                  </p>
                )}

                <p className="mb-3 line-clamp-3 text-sm text-slate-700 dark:text-slate-300">
                  {ticket.description}
                </p>

                {/* Named authors are shown outright — there was never a
                    promise of privacy to break. */}
                {!ticket.isAnonymous && ticket.author && (
                  <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                    Reported by {ticket.author.fullName}
                  </p>
                )}

                {identity && (
                  <p className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                    <span className="font-medium">{identity.fullName}</span>
                    {identity.matricNumber ? ` · ${identity.matricNumber}` : ''}
                    {identity.email ? ` · ${identity.email}` : ''}
                  </p>
                )}

                {revealing === ticket.id ? (
                  <form onSubmit={(e) => submitReveal(e, ticket)} className="mb-3 space-y-2">
                    <label
                      htmlFor={`reason-${ticket.id}`}
                      className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                    >
                      Why does this need the author&apos;s identity?
                    </label>
                    <textarea
                      id={`reason-${ticket.id}`}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      rows={2}
                      required
                      minLength={10}
                      placeholder="e.g. Repeated targeted harassment of a named student."
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                    />
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Your name, the reason and the time are recorded permanently.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        disabled={busy}
                        className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-60"
                      >
                        Confirm reveal
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRevealing(null);
                          setReason('');
                        }}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium dark:border-slate-700 dark:text-slate-200"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}

                <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <Link
                    to={`/tickets/${ticket.id}`}
                    className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <Eye size={14} aria-hidden="true" />
                    Open
                  </Link>

                  <button
                    type="button"
                    onClick={() => unflag(ticket)}
                    disabled={busy}
                    className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <ShieldCheck size={14} aria-hidden="true" />
                    Clear flag
                  </button>

                  {ticket.isAnonymous && !identity && revealing !== ticket.id && (
                    <button
                      type="button"
                      onClick={() => setRevealing(ticket.id)}
                      disabled={busy}
                      className="flex items-center gap-1.5 rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-60 dark:border-amber-900/60 dark:text-amber-300 dark:hover:bg-amber-950/30"
                    >
                      <UserSearch size={14} aria-hidden="true" />
                      Reveal author
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => remove(ticket)}
                    disabled={busy}
                    className="flex items-center gap-1.5 rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/30"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Delete report
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
