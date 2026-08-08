/**
 * Filter bar for the ticket list.
 *
 * Writes straight to the URL search params — the parent reads them back,
 * so there's no duplicated state to keep in sync.
 *
 * The search box is debounced (400ms) so typing doesn't fire a request
 * per keystroke.
 */

import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { STATUSES, URGENCIES, CATEGORIES, SORT_OPTIONS } from '../lib/constants.js';

const SELECTS = [
  { name: 'status', label: 'Status', options: STATUSES },
  { name: 'category', label: 'Category', options: CATEGORIES },
  { name: 'urgency', label: 'Urgency', options: URGENCIES },
];

export default function TicketFilters({ params, onChange, onReset }) {
  const [search, setSearch] = useState(params.q ?? '');

  // Keep the box in sync when filters are cleared elsewhere. Done during
  // render rather than in an effect so the input never shows a stale value
  // for a frame after a reset.
  const incomingQuery = params.q ?? '';
  const [syncedQuery, setSyncedQuery] = useState(incomingQuery);

  if (syncedQuery !== incomingQuery) {
    setSyncedQuery(incomingQuery);
    setSearch(incomingQuery);
  }

  useEffect(() => {
    if (search === (params.q ?? '')) return;

    const timer = setTimeout(() => onChange({ q: search, page: 1 }), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const active = SELECTS.some(({ name }) => params[name]) || params.q;

  const selectClass =
    'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633]';

  return (
    <div className="mb-6 space-y-3">
      <div className="relative">
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
          aria-hidden="true"
        />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search issues by description, location or ticket number…"
          aria-label="Search issues"
          className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633] dark:border-slate-700"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {SELECTS.map(({ name, label, options }) => (
          <select
            key={name}
            value={params[name] ?? ''}
            onChange={(e) => onChange({ [name]: e.target.value, page: 1 })}
            aria-label={label}
            className={selectClass}
          >
            <option value="">All {label.toLowerCase()}</option>
            {Object.entries(options).map(([value, { label: optionLabel }]) => (
              <option key={value} value={value}>
                {optionLabel}
              </option>
            ))}
          </select>
        ))}

        <select
          value={params.sort ?? 'newest'}
          onChange={(e) => onChange({ sort: e.target.value, page: 1 })}
          aria-label="Sort by"
          className={`${selectClass} ml-auto`}
        >
          {SORT_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        {active && (
          <button
            type="button"
            onClick={onReset}
            className="flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400"
          >
            <X size={14} />
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
