/**
 * SRC representative dashboard.
 *
 * Surfaces the work queue: what's overdue, what's unassigned, and how
 * the load breaks down by category. Charts use plain CSS bars rather
 * than a charting library — a few dozen KB saved for a handful of rows.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Inbox, TrendingUp } from 'lucide-react';

import { ticketApi } from '../lib/api.js';
import { useTickets } from '../hooks/useTickets.js';
import { STATUSES, CATEGORIES } from '../lib/constants.js';
import TicketCard from '../components/TicketCard.jsx';
import { TicketCardSkeleton } from '../components/Spinner.jsx';

/** Horizontal bar; width is relative to the largest value in the set. */
function Bar({ label, value, max, colour = 'bg-[#006633]' }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-slate-600 dark:text-slate-400">{label}</span>
        <span className="font-medium text-slate-900 dark:text-white">{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const [stats, setStats] = useState(null);

  // Oldest overdue first — that's the queue that needs attention
  const params = useMemo(() => ({ overdue: true, limit: 10, sort: 'oldest' }), []);
  const { tickets, loading, applyVote } = useTickets(params);

  useEffect(() => {
    ticketApi
      .stats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  const maxStatus = Math.max(1, ...Object.values(stats?.byStatus ?? {}));
  const maxCategory = Math.max(1, ...Object.values(stats?.byCategory ?? {}));

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold text-slate-900 dark:text-white">Representative dashboard</h1>
      <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">Campus-wide issue overview.</p>

      <dl className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          ['Total', stats?.total ?? 0, 'text-slate-900'],
          ['Overdue', stats?.overdue ?? 0, 'text-red-600'],
          ['Pending', stats?.byStatus?.PENDING ?? 0, 'text-amber-600'],
          ['Resolved', stats?.byStatus?.RESOLVED ?? 0, 'text-green-600'],
        ].map(([label, value, colour]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <dd className={`text-2xl font-bold ${colour}`}>{value}</dd>
            <dt className="mt-1 text-xs text-slate-500 dark:text-slate-400">{label}</dt>
          </div>
        ))}
      </dl>

      <div className="mb-8 grid gap-5 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="mb-4 flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
            <TrendingUp size={17} className="text-[#006633]" />
            By status
          </h2>
          <div className="space-y-3">
            {Object.entries(STATUSES).map(([key, { label }]) => (
              <Bar key={key} label={label} value={stats?.byStatus?.[key] ?? 0} max={maxStatus} />
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="mb-4 flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
            <Inbox size={17} className="text-[#006633]" />
            By category
          </h2>
          <div className="space-y-3">
            {Object.entries(CATEGORIES).map(([key, { label }]) => (
              <Bar
                key={key}
                label={label}
                value={stats?.byCategory?.[key] ?? 0}
                max={maxCategory}
                colour="bg-amber-500"
              />
            ))}
          </div>
        </section>
      </div>

      <h2 className="mb-4 flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
        <AlertTriangle size={17} className="text-red-500" />
        Overdue issues
      </h2>

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }, (_, i) => (
            <TicketCardSkeleton key={i} />
          ))}
        </div>
      ) : tickets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white py-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <p className="font-medium text-slate-900 dark:text-white">Nothing overdue</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Every issue is within its target resolution time.
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-4">
            {tickets.map((ticket) => (
              <TicketCard key={ticket.id} ticket={ticket} onVoteChange={applyVote} />
            ))}
          </div>
          <div className="mt-6 text-center">
            <Link
              to="/tickets?status=PENDING"
              className="text-sm font-medium text-[#006633] hover:underline"
            >
              View the full queue →
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
