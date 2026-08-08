/**
 * Public ticket tracking.
 *
 * A student can share "SRC-000142" with a friend, or check progress on a
 * phone they aren't signed in on. Deliberately shows status only — the
 * API returns nothing sensitive here because ticket numbers are
 * sequential and therefore guessable.
 */

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { ticketApi } from '../lib/api.js';
import { STATUSES, CATEGORIES, formatDate } from '../lib/constants.js';
import { Spinner } from '../components/Spinner.jsx';

export default function TrackTicket() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get('ref') ?? '');
  const [ticket, setTicket] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const search = async (event) => {
    event?.preventDefault();

    const ref = query.trim();
    if (!ref) return;

    setLoading(true);
    setError(null);
    setTicket(null);

    // Keeps the reference in the URL so the result can be shared or
    // bookmarked, which is the whole point of this page.
    setParams({ ref }, { replace: true });

    try {
      const { ticket: found } = await ticketApi.track(ref);
      setTicket(found);
    } catch (err) {
      setError(
        err.status === 404
          ? "We couldn't find a public report with that number. Check the reference, or sign in if the report was marked private."
          : err.displayMessage
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Track a report</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Enter the reference number you were given (for example{' '}
        <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">SRC-000142</code>). No
        account needed.
      </p>

      <form onSubmit={search} className="mt-6 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="SRC-000142"
          aria-label="Ticket reference number"
          className="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:placeholder-slate-500"
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? <Spinner size="sm" /> : 'Track'}
        </button>
      </form>

      {error && (
        <div
          role="alert"
          className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {error}
        </div>
      )}

      {ticket && (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between gap-4">
            <span className="font-mono text-sm text-slate-500 dark:text-slate-400">
              {ticket.ticketNumber}
            </span>
            <span
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                STATUSES[ticket.status]?.className ?? 'bg-slate-100 text-slate-700'
              }`}
            >
              {STATUSES[ticket.status]?.label ?? ticket.status}
            </span>
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Category</dt>
              <dd className="mt-0.5 font-medium text-slate-900 dark:text-white">
                {CATEGORIES[ticket.category]?.label ?? ticket.category}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Handled by</dt>
              <dd className="mt-0.5 font-medium text-slate-900 dark:text-white">
                {ticket.department ?? 'Not yet routed'}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Submitted</dt>
              <dd className="mt-0.5 font-medium text-slate-900 dark:text-white">
                {formatDate(ticket.createdAt) || '—'}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">
                {ticket.resolvedAt ? 'Resolved' : 'Last update'}
              </dt>
              <dd className="mt-0.5 font-medium text-slate-900 dark:text-white">
                {formatDate(ticket.resolvedAt ?? ticket.updatedAt) || '—'}
              </dd>
            </div>
          </dl>

          <p className="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            Only status information is shown here.{' '}
            <Link to="/login" className="font-medium text-blue-600 hover:underline">
              Sign in
            </Link>{' '}
            to read the full report, add a comment or reopen it.
          </p>
        </div>
      )}
    </div>
  );
}
