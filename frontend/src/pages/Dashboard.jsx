/**
 * Student dashboard — the issues you reported, and how they're going.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PlusCircle, Inbox } from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { useTickets } from '../hooks/useTickets.js';
import { ticketApi } from '../lib/api.js';
import TicketCard from '../components/TicketCard.jsx';
import { TicketCardSkeleton } from '../components/Spinner.jsx';

export default function Dashboard() {
  const { profile } = useAuth();
  const [stats, setStats] = useState(null);

  // "mine" is resolved server-side from the token
  const params = useMemo(() => ({ mine: true, limit: 10, sort: 'newest' }), []);
  const { tickets, loading, applyVote } = useTickets(params);

  useEffect(() => {
    ticketApi
      .stats({ params: { mine: true } })
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  const firstName = profile?.fullName?.split(' ')[0] ?? 'there';

  const tiles = [
    ['Reported', stats?.total ?? 0, 'text-slate-900'],
    ['Pending', stats?.byStatus?.PENDING ?? 0, 'text-amber-600'],
    ['In progress', stats?.byStatus?.IN_PROGRESS ?? 0, 'text-blue-600'],
    ['Resolved', stats?.byStatus?.RESOLVED ?? 0, 'text-green-600'],
  ];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-white">Welcome back, {firstName}</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Here&apos;s what you&apos;ve reported.</p>
        </div>
        <Link
          to="/tickets/new"
          className="flex items-center gap-2 rounded-lg bg-[#006633] px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
        >
          <PlusCircle size={16} />
          Report an issue
        </Link>
      </div>

      <dl className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {tiles.map(([label, value, colour]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <dd className={`text-2xl font-bold ${colour}`}>{value}</dd>
            <dt className="mt-1 text-xs text-slate-500 dark:text-slate-400">{label}</dt>
          </div>
        ))}
      </dl>

      <h2 className="mb-4 font-semibold text-slate-900 dark:text-white">Your recent issues</h2>

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }, (_, i) => (
            <TicketCardSkeleton key={i} />
          ))}
        </div>
      ) : tickets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white py-14 text-center dark:border-slate-700 dark:bg-slate-900">
          <Inbox size={36} className="mx-auto mb-3 text-slate-300 dark:text-slate-600" aria-hidden="true" />
          <h3 className="mb-1 font-medium text-slate-900 dark:text-white">Nothing reported yet</h3>
          <p className="mx-auto mb-5 max-w-sm text-sm text-slate-600 dark:text-slate-400">
            Spotted a problem on campus? Let the SRC know.
          </p>
          <Link
            to="/tickets/new"
            className="inline-block rounded-lg bg-[#006633] px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            Report your first issue
          </Link>
        </div>
      ) : (
        <>
          <div className="space-y-4">
            {tickets.map((ticket) => (
              <TicketCard key={ticket.id} ticket={ticket} onVoteChange={applyVote} />
            ))}
          </div>
          <div className="mt-6 text-center">
            <Link to="/tickets" className="text-sm font-medium text-[#006633] hover:underline">
              Browse all campus issues →
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
