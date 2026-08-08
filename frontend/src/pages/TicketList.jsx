/**
 * Public issue board.
 *
 * All filter state lives in the URL, so this page is fully shareable —
 * "here are the overdue ICT issues" is just a link.
 */

import { useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PlusCircle, Inbox, AlertCircle } from 'lucide-react';

import { useTickets } from '../hooks/useTickets.js';
import { useAuth } from '../context/AuthContext.jsx';
import TicketCard from '../components/TicketCard.jsx';
import TicketFilters from '../components/TicketFilters.jsx';
import { TicketCardSkeleton } from '../components/Spinner.jsx';

export default function TicketList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { isAuthenticated } = useAuth();

  // URL is the single source of truth for filters
  const params = useMemo(() => {
    const entries = Object.fromEntries(searchParams);
    return { ...entries, page: Number(entries.page) || 1, limit: 20 };
  }, [searchParams]);

  const { tickets, pagination, loading, error, applyVote } = useTickets(params);

  const handleChange = useCallback(
    (updates) => {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        Object.entries(updates).forEach(([key, value]) => {
          if (value === '' || value == null) next.delete(key);
          else next.set(key, String(value));
        });
        return next;
      });
    },
    [setSearchParams]
  );

  const handleReset = useCallback(() => setSearchParams({}), [setSearchParams]);

  const goToPage = (page) => {
    handleChange({ page });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-white">Campus issues</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {pagination
              ? `${pagination.total} issue${pagination.total === 1 ? '' : 's'} reported`
              : 'Loading…'}
          </p>
        </div>

        {isAuthenticated && (
          <Link
            to="/tickets/new"
            className="flex items-center gap-2 rounded-lg bg-[#006633] px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            <PlusCircle size={16} />
            Report an issue
          </Link>
        )}
      </div>

      <TicketFilters params={params} onChange={handleChange} onReset={handleReset} />

      {error && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
        >
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }, (_, i) => (
            <TicketCardSkeleton key={i} />
          ))}
        </div>
      ) : tickets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white py-16 text-center dark:border-slate-700 dark:bg-slate-900">
          <Inbox size={40} className="mx-auto mb-3 text-slate-300 dark:text-slate-600" aria-hidden="true" />
          <h2 className="mb-1 font-medium text-slate-900 dark:text-white">No issues found</h2>
          <p className="mx-auto mb-5 max-w-sm text-sm text-slate-600 dark:text-slate-400">
            {searchParams.toString()
              ? 'Try widening your filters.'
              : 'Nothing has been reported yet. Be the first.'}
          </p>
          {searchParams.toString() ? (
            <button
              type="button"
              onClick={handleReset}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50 dark:border-slate-700"
            >
              Clear filters
            </button>
          ) : (
            isAuthenticated && (
              <Link
                to="/tickets/new"
                className="inline-block rounded-lg bg-[#006633] px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
              >
                Report an issue
              </Link>
            )
          )}
        </div>
      ) : (
        <>
          <div className="space-y-4">
            {tickets.map((ticket) => (
              <TicketCard key={ticket.id} ticket={ticket} onVoteChange={applyVote} />
            ))}
          </div>

          {pagination && pagination.totalPages > 1 && (
            <nav
              className="mt-8 flex items-center justify-center gap-2"
              aria-label="Pagination"
            >
              <button
                type="button"
                onClick={() => goToPage(pagination.page - 1)}
                disabled={!pagination.hasPrev}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-slate-700"
              >
                Previous
              </button>
              <span className="px-3 text-sm text-slate-600 dark:text-slate-400">
                Page {pagination.page} of {pagination.totalPages}
              </span>
              <button
                type="button"
                onClick={() => goToPage(pagination.page + 1)}
                disabled={!pagination.hasNext}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-slate-700"
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
