/**
 * Analytics — how the SRC is actually performing.
 *
 * Staff-visible. The numbers here come straight from the API's grouped
 * queries; nothing is recomputed client-side, so what an admin quotes in
 * a meeting matches the database.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { adminApi } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { STATUSES, CATEGORIES } from '../lib/constants.js';
import { Spinner } from '../components/Spinner.jsx';

const WINDOWS = [7, 30, 90, 365];

const SLICE_COLOURS = ['#006633', '#0ea5e9', '#f59e0b', '#8b5cf6', '#ef4444', '#64748b'];

// Fixed severity order — sorting by count would put CRITICAL last on a
// good week, which is the one row that should never be hard to find.
const URGENCY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const URGENCY_COLOURS = ['#ef4444', '#f59e0b', '#0ea5e9', '#64748b'];

function Stat({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold text-slate-900 dark:text-white">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  );
}

export default function Analytics() {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (signal) => {
      setLoading(true);
      try {
        setData(await adminApi.analytics(days, { signal }));
      } catch (err) {
        if (err.name !== 'AbortError') toast.error(err.displayMessage);
      } finally {
        setLoading(false);
      }
    },
    [days, toast]
  );

  useEffect(() => {
    const controller = new AbortController();
    // Fetch-on-mount and on window change. `load` flips `loading`
    // synchronously so switching to 90d shows a spinner immediately
    // rather than stale numbers under a new heading.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!data) return null;

  const statusData = Object.entries(data.tickets.byStatus).map(([key, value]) => ({
    name: STATUSES[key]?.label ?? key,
    value,
  }));

  const categoryData = Object.entries(data.tickets.byCategory).map(([key, value]) => ({
    name: CATEGORIES[key]?.label ?? key,
    value,
  }));

  // Urgency was already returned by the API but never displayed, so the
  // one breakdown that tells staff what to do *first* was invisible.
  const urgencyData = URGENCY_ORDER.filter((key) => data.tickets.byUrgency[key]).map((key) => ({
    name: key.charAt(0) + key.slice(1).toLowerCase(),
    value: data.tickets.byUrgency[key],
  }));

  // "12 Mar" reads better on an axis than "2026-03-12".
  const trendData = (data.trend ?? []).map((point) => ({
    ...point,
    label: new Date(point.date).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    }),
  }));

  const { performance, satisfaction } = data;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Analytics</h1>

        <div className="flex gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-800">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setDays(w)}
              className={`rounded-md px-3 py-1 text-sm transition ${
                days === w
                  ? 'bg-white font-medium text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400'
              }`}
            >
              {w === 365 ? '1y' : `${w}d`}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total reports" value={data.tickets.total} />
        <Stat
          label="Avg resolution"
          // null means nothing was resolved in the window — "0h" would
          // read as instant, which is the opposite of the truth.
          value={
            performance.avgResolutionHours === null
              ? '—'
              : `${performance.avgResolutionHours}h`
          }
          hint={`${performance.resolvedInWindow} resolved in ${days}d`}
        />
        <Stat
          label="Within SLA"
          value={
            performance.slaCompliancePct === null ? '—' : `${performance.slaCompliancePct}%`
          }
          hint={`${performance.overdue} overdue now`}
        />
        <Stat
          label="Satisfaction"
          value={satisfaction.averageScore === null ? '—' : `${satisfaction.averageScore}/5`}
          hint={`${satisfaction.responses} ${
            satisfaction.responses === 1 ? 'rating' : 'ratings'
          }`}
        />
      </div>

      {trendData.length > 1 && (
        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="mb-1 font-semibold text-slate-900 dark:text-white">
            Submitted vs resolved
          </h2>
          <p className="mb-4 text-xs text-slate-500 dark:text-slate-400">
            {/* The gap between the lines is the point: resolved trailing
                submitted means the backlog is growing. */}
            Per {data.trendGranularity === 'week' ? 'week' : 'day'}. When the resolved line
            sits below submitted, the backlog is growing.
          </p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip cursor={{ opacity: 0.1 }} />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="created"
                  name="Submitted"
                  stroke="#0ea5e9"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="resolved"
                  name="Resolved"
                  stroke="#006633"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="mb-4 font-semibold text-slate-900 dark:text-white">
            Reports by status
          </h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={statusData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={55}
                  outerRadius={90}
                  paddingAngle={2}
                >
                  {statusData.map((entry, i) => (
                    <Cell key={entry.name} fill={SLICE_COLOURS[i % SLICE_COLOURS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
            {statusData.map((entry, i) => (
              <li key={entry.name} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block size-2.5 rounded-full"
                  style={{ backgroundColor: SLICE_COLOURS[i % SLICE_COLOURS.length] }}
                />
                {entry.name} ({entry.value})
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="mb-4 font-semibold text-slate-900 dark:text-white">
            Reports by category ({days}d)
          </h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={categoryData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-15} dy={8} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip cursor={{ opacity: 0.1 }} />
                <Bar dataKey="value" fill="#006633" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {urgencyData.length > 0 && (
          <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="mb-4 font-semibold text-slate-900 dark:text-white">
              Reports by urgency ({days}d)
            </h2>
            <ul className="space-y-3">
              {urgencyData.map((entry, i) => {
                const max = Math.max(...urgencyData.map((u) => u.value));
                return (
                  <li key={entry.name}>
                    <div className="mb-1 flex items-center justify-between text-sm text-slate-700 dark:text-slate-300">
                      <span>{entry.name}</span>
                      <span className="font-medium">{entry.value}</span>
                    </div>
                    {/* A plain proportional bar — a second chart library
                        canvas here would cost more than it explains. */}
                    <div
                      className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
                      role="presentation"
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${max ? (entry.value / max) * 100 : 0}%`,
                          backgroundColor: URGENCY_COLOURS[i % URGENCY_COLOURS.length],
                        }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {data.topDepartments.length > 0 && (
          <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="mb-4 font-semibold text-slate-900 dark:text-white">
              Busiest departments
            </h2>
            <ul className="space-y-2">
              {data.topDepartments.map((dept) => (
                <li
                  key={dept.id}
                  className="flex items-center justify-between text-sm text-slate-700 dark:text-slate-300"
                >
                  <span>{dept.name}</span>
                  <span className="font-medium">{dept.ticketCount}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
