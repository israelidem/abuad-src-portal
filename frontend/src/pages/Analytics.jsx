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
import { useTheme } from '../context/ThemeContext.jsx';
import { STATUSES, CATEGORIES } from '../lib/constants.js';
import {
  Skeleton,
  StatSkeleton,
  ChartCardSkeleton,
} from '../components/Spinner.jsx';

const WINDOWS = [7, 30, 90, 365];

const SLICE_COLOURS = ['#006633', '#0ea5e9', '#f59e0b', '#8b5cf6', '#ef4444', '#64748b'];

// Fixed severity order — sorting by count would put CRITICAL last on a
// good week, which is the one row that should never be hard to find.
const URGENCY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const URGENCY_COLOURS = ['#ef4444', '#f59e0b', '#0ea5e9', '#64748b'];

/**
 * Chart colours per theme.
 *
 * Recharts renders SVG with inline attributes and builds its tooltip as a
 * plain div with an inline style object. Neither can be reached by a
 * Tailwind `dark:` class, which is why the charts stayed light while the
 * rest of the admin dashboard went dark — the tooltip in particular was
 * white-on-white text, unreadable rather than merely mismatched.
 *
 * The series colours (SLICE_COLOURS, URGENCY_COLOURS, the green and blue
 * lines) are deliberately unchanged: they carry meaning, they're the same
 * palette the status badges use, and they hold up on both backgrounds.
 * Only the chrome — axes, grid, tooltip surface — is themed.
 */
const CHART_THEME = {
  light: {
    axis: '#64748b', // slate-500
    grid: '#cbd5e1', // slate-300
    tooltipBg: '#ffffff',
    tooltipBorder: '#e2e8f0',
    tooltipText: '#0f172a',
  },
  dark: {
    axis: '#94a3b8', // slate-400 — lighter, for contrast against slate-900
    grid: '#334155', // slate-700
    tooltipBg: '#0f172a', // slate-900
    tooltipBorder: '#1e293b', // slate-800
    tooltipText: '#f1f5f9', // slate-100
  },
};

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
  // `resolved` is the concrete light/dark in effect, already accounting
  // for "system". Charts need an actual colour, not a preference.
  const { resolved } = useTheme();
  const chart = CHART_THEME[resolved] ?? CHART_THEME.light;

  // Recharts' tooltip takes style objects, so the theme has to be passed
  // as props on every instance. Built once here to keep the three call
  // sites from drifting apart.
  const tooltipStyles = {
    contentStyle: {
      backgroundColor: chart.tooltipBg,
      border: `1px solid ${chart.tooltipBorder}`,
      borderRadius: '0.5rem',
      color: chart.tooltipText,
      fontSize: '0.75rem',
    },
    // itemStyle and labelStyle are separate: without them Recharts keeps
    // its own near-black defaults for the value rows, which disappear
    // against the dark surface above.
    itemStyle: { color: chart.tooltipText },
    labelStyle: { color: chart.tooltipText },
  };

  const axisProps = {
    tick: { fontSize: 11, fill: chart.axis },
    stroke: chart.axis,
  };

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
    // Mirrors the real layout below — 4 stat tiles, the wide trend panel,
    // then two 2-column chart rows. A centred spinner meant the entire
    // page arrived at once and shoved itself into place; this is the one
    // route with enough structure for that reflow to be jarring.
    //
    // aria-busy + a single role="status" on the wrapper: the individual
    // Skeletons are aria-hidden, so assistive tech hears "loading
    // analytics" once rather than a dozen empty nodes.
    return (
      <div
        className="mx-auto max-w-6xl px-4 py-8"
        role="status"
        aria-busy="true"
        aria-label="Loading analytics"
      >
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-44" />
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <StatSkeleton key={i} />
          ))}
        </div>

        {/* The trend chart is taller than the rest, hence the override. */}
        <div className="mt-6">
          <ChartCardSkeleton height="h-64" />
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <ChartCardSkeleton />
          <ChartCardSkeleton />
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <ChartCardSkeleton />
          <ChartCardSkeleton />
        </div>
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
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke={chart.grid}
                  opacity={0.3}
                />
                <XAxis dataKey="label" {...axisProps} minTickGap={24} />
                <YAxis allowDecimals={false} {...axisProps} />
                <Tooltip cursor={{ opacity: 0.1 }} {...tooltipStyles} />
                <Legend wrapperStyle={{ fontSize: '0.75rem', color: chart.axis }} />
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
                <Tooltip {...tooltipStyles} />
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
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke={chart.grid}
                  opacity={0.3}
                />
                <XAxis dataKey="name" {...axisProps} interval={0} angle={-15} dy={8} />
                <YAxis allowDecimals={false} {...axisProps} />
                <Tooltip cursor={{ opacity: 0.1 }} {...tooltipStyles} />
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
