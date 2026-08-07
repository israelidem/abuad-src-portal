/**
 * Public landing page.
 *
 * Shows live counts so the board looks active to a first-time visitor,
 * and degrades quietly to zeros if the stats call fails.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ShieldCheck, Clock, Users } from 'lucide-react';
import { ticketApi } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';

const POINTS = [
  {
    icon: ShieldCheck,
    title: 'Report anonymously',
    body: 'Raise sensitive issues without your name attached to them.',
  },
  {
    icon: Clock,
    title: 'Track every step',
    body: 'Each issue has a target resolution time and a public timeline.',
  },
  {
    icon: Users,
    title: 'Back what matters',
    body: 'Upvote issues so the SRC can see what affects the most students.',
  },
];

export default function Home() {
  const { isAuthenticated } = useAuth();
  const [stats, setStats] = useState(null);

  useEffect(() => {
    // Public counts; failure just hides the tiles
    ticketApi
      .stats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  return (
    <div>
      <section className="rounded-2xl bg-[#006633] px-6 py-14 text-center text-white sm:px-12">
        <h1 className="mx-auto mb-4 max-w-2xl text-3xl font-bold leading-tight sm:text-4xl">
          Campus problems, tracked until they&apos;re fixed
        </h1>
        <p className="mx-auto mb-8 max-w-xl text-white/85">
          Report an issue to the Students&apos; Representative Council and follow it from submission
          to resolution.
        </p>

        <div className="flex flex-wrap justify-center gap-3">
          <Link
            to={isAuthenticated ? '/tickets/new' : '/signup'}
            className="flex items-center gap-2 rounded-lg bg-[#FAF92A] px-6 py-3 text-sm font-semibold text-[#006633] hover:brightness-95"
          >
            {isAuthenticated ? 'Report an issue' : 'Get started'}
            <ArrowRight size={16} />
          </Link>
          <Link
            to="/tickets"
            className="rounded-lg border border-white/30 px-6 py-3 text-sm font-semibold hover:bg-white/10"
          >
            Browse issues
          </Link>
        </div>
      </section>

      {stats && (
        <dl className="mt-6 grid grid-cols-3 gap-4">
          {[
            ['Reported', stats.total],
            ['Resolved', stats.byStatus?.RESOLVED ?? 0],
            ['In progress', stats.byStatus?.IN_PROGRESS ?? 0],
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-xl border border-slate-200 bg-white p-5 text-center"
            >
              <dd className="text-2xl font-bold text-[#006633]">{value ?? 0}</dd>
              <dt className="mt-1 text-xs text-slate-500">{label}</dt>
            </div>
          ))}
        </dl>
      )}

      <section className="mt-10 grid gap-5 sm:grid-cols-3">
        {POINTS.map(({ icon: Icon, title, body }) => (
          <div key={title} className="rounded-xl border border-slate-200 bg-white p-6">
            <Icon size={24} className="mb-3 text-[#006633]" aria-hidden="true" />
            <h2 className="mb-1 font-semibold text-slate-900">{title}</h2>
            <p className="text-sm text-slate-600">{body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
