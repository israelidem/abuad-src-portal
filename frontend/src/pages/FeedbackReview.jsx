/**
 * Admin review for §9 feedback and §10 ratings.
 *
 * Two tabs on one page rather than two pages, because they answer the same
 * question from different directions: ratings say *how bad it is*, feedback
 * says *what is broken*. Reading one without the other invites acting on a
 * loud minority.
 *
 * Every list here is cursor-paginated. Loading all feedback or all ratings
 * would be the exact unbounded query the brief warns about — with 5,000
 * students, "select everything and render it" is a page that never paints.
 */

import { useCallback, useEffect, useState } from 'react';
import { Star, Loader2, ExternalLink, ImageIcon } from 'lucide-react';

import { feedbackApi } from '../lib/api.js';
import { getAttachmentUrl } from '../lib/uploads.js';
import { useToast } from '../context/ToastContext.jsx';
import { Spinner } from '../components/Spinner.jsx';

const STATUSES = ['NEW', 'IN_REVIEW', 'RESOLVED', 'CLOSED'];

const STATUS_LABELS = {
  NEW: 'New',
  IN_REVIEW: 'In review',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

const STATUS_STYLES = {
  NEW: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  IN_REVIEW: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  RESOLVED: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  CLOSED: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
};

const CATEGORY_LABELS = {
  BUG: 'Bug',
  TECHNICAL: 'Technical',
  USABILITY: 'Usability',
  SUGGESTION: 'Suggestion',
  GENERAL: 'General',
  OTHER: 'Other',
};

const formatDate = (iso) =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Read-only star row for the ratings list. */
function Stars({ value }) {
  return (
    // The accessible name carries the number; the icons are decorative, so
    // a screen reader hears "4 out of 5 stars" instead of five "star"s.
    <span className="inline-flex items-center gap-0.5" aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          size={14}
          aria-hidden="true"
          className={n <= value ? 'fill-amber-400 text-amber-400' : 'text-slate-300 dark:text-slate-600'}
        />
      ))}
    </span>
  );
}

function FeedbackTab() {
  const toast = useToast();

  const [status, setStatus] = useState('NEW');
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [savingId, setSavingId] = useState(null);

  const load = useCallback(
    async (nextStatus, signal) => {
      setLoading(true);
      try {
        const data = await feedbackApi.list({ status: nextStatus, limit: 20 }, { signal });
        setItems(data.items);
        setCounts(data.counts);
        setCursor(data.nextCursor);
      } catch (err) {
        if (err.name !== 'AbortError') toast.error(err.displayMessage || 'Could not load feedback.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(status, controller.signal);
    return () => controller.abort();
  }, [status, load]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const data = await feedbackApi.list({ status, cursor, limit: 20 });
      // Append rather than replace — the cursor walks forward, so the
      // already-rendered rows stay put and scroll position is preserved.
      setItems((prev) => [...prev, ...data.items]);
      setCursor(data.nextCursor);
    } catch (err) {
      toast.error(err.displayMessage || 'Could not load more.');
    } finally {
      setLoadingMore(false);
    }
  };

  const changeStatus = async (id, nextStatus) => {
    setSavingId(id);
    try {
      await feedbackApi.update(id, { status: nextStatus });

      /**
       * Drop the row from the current view, since it no longer matches the
       * active filter, and adjust both counts locally. Refetching the whole
       * page for a single status change is a wasted round-trip on a queue
       * an admin may be working through quickly.
       */
      setItems((prev) => prev.filter((item) => item.id !== id));
      setCounts((prev) => ({
        ...prev,
        [status]: Math.max(0, (prev[status] || 0) - 1),
        [nextStatus]: (prev[nextStatus] || 0) + 1,
      }));
      toast.success(`Marked ${STATUS_LABELS[nextStatus].toLowerCase()}.`);
    } catch (err) {
      toast.error(err.displayMessage || 'Could not update.');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Filter tabs. role=tablist so arrow keys and the "3 of 4" position
          are announced, instead of four unrelated buttons. */}
      <div role="tablist" aria-label="Feedback status" className="flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={status === s}
            onClick={() => setStatus(s)}
            className={`flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
              status === s
                ? 'bg-[#006633] text-white'
                : 'bg-white text-slate-700 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
            }`}
          >
            {STATUS_LABELS[s]}
            <span
              className={`rounded-full px-1.5 py-0.5 text-xs ${
                status === s ? 'bg-white/20' : 'bg-slate-100 dark:bg-slate-700'
              }`}
            >
              {counts[s] ?? 0}
            </span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          Nothing {STATUS_LABELS[status].toLowerCase()}.
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li
              key={item.id}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                      {CATEGORY_LABELS[item.category] || item.category}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        STATUS_STYLES[item.status]
                      }`}
                    >
                      {STATUS_LABELS[item.status]}
                    </span>
                  </div>

                  {/* Interpolated as text. React escapes it, so a subject
                      containing markup renders as characters. */}
                  <h3 className="mt-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {item.subject}
                  </h3>
                  {/* whitespace-pre-wrap keeps the reporter's line breaks —
                      steps-to-reproduce are unreadable as one blob. */}
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">
                    {item.description}
                  </p>
                </div>
              </div>

              <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400 sm:grid-cols-2">
                <div className="flex gap-1">
                  <dt className="font-medium">From:</dt>
                  {/*
                    The API returns only fullName and role — no email, no
                    matric number. A bug report does not need identifying
                    detail, so it is not sent to the client at all.
                  */}
                  <dd>
                    {item.user?.fullName ?? 'Unknown'}
                    {item.user?.role ? ` (${item.user.role})` : ''}
                  </dd>
                </div>
                <div className="flex gap-1">
                  <dt className="font-medium">Submitted:</dt>
                  <dd>
                    <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                  </dd>
                </div>
                {item.pageUrl && (
                  <div className="flex min-w-0 gap-1">
                    <dt className="font-medium">Page:</dt>
                    {/* Not a link: it is user-supplied, and a javascript:
                        URL rendered as an anchor is a one-click XSS. Shown
                        as text so it can be read and copied. */}
                    <dd className="truncate">{item.pageUrl}</dd>
                  </div>
                )}
                {item.appVersion && (
                  <div className="flex gap-1">
                    <dt className="font-medium">Version:</dt>
                    <dd>{item.appVersion}</dd>
                  </div>
                )}
              </dl>

              {item.screenshotPath && (
                <p className="mt-2">
                  {/* Built by getAttachmentUrl from the stored public_id, so
                      the href is always a Cloudinary URL under our cloud —
                      never a raw value from the record. */}
                  <a
                    href={getAttachmentUrl(item.screenshotPath)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium text-[#006633] hover:underline dark:text-green-400"
                  >
                    <ImageIcon size={14} aria-hidden="true" />
                    View screenshot
                    <ExternalLink size={12} aria-hidden="true" />
                  </a>
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3 dark:border-slate-700">
                {STATUSES.filter((s) => s !== item.status).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => changeStatus(item.id, s)}
                    disabled={savingId === item.id}
                    className="flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006633] disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
                  >
                    {savingId === item.id && (
                      <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                    )}
                    Mark {STATUS_LABELS[s].toLowerCase()}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {cursor && !loading && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {loadingMore && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
          Load more
        </button>
      )}
    </div>
  );
}

function RatingsTab() {
  const toast = useToast();

  const [summary, setSummary] = useState(null);
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    // Both in parallel: the summary and the first page are independent, and
    // sequencing them would double the time to first paint.
    Promise.all([
      feedbackApi.ratingSummary({ signal: controller.signal }),
      feedbackApi.ratingList({ limit: 20 }, { signal: controller.signal }),
    ])
      .then(([summaryData, listData]) => {
        setSummary(summaryData);
        setItems(listData.items);
        setCursor(listData.nextCursor);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') toast.error(err.displayMessage || 'Could not load ratings.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [toast]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const data = await feedbackApi.ratingList({ cursor, limit: 20 });
      setItems((prev) => [...prev, ...data.items]);
      setCursor(data.nextCursor);
    } catch (err) {
      toast.error(err.displayMessage || 'Could not load more.');
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  const total = summary?.total ?? 0;
  const maxBar = Math.max(1, ...Object.values(summary?.distribution ?? {}));

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Average
          </p>
          <p className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {summary?.average ?? '—'}
            <span className="text-sm font-normal text-slate-500"> / 5</span>
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Ratings given
          </p>
          <p className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">{total}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Dismissed
          </p>
          {/* Worth showing: a high dismissal count next to a high average
              means the average is drawn from a self-selected few. */}
          <p className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {summary?.dismissals ?? 0}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Distribution</h3>
        <ul className="mt-3 space-y-1.5">
          {[5, 4, 3, 2, 1].map((star) => {
            const count = summary?.distribution?.[star] ?? 0;
            return (
              <li key={star} className="flex items-center gap-2 text-xs">
                <span className="w-8 shrink-0 text-slate-600 dark:text-slate-400">{star}★</span>
                {/* Decorative bar; the count beside it carries the value, so
                    the chart is not the only way to read the data. */}
                <span
                  className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700"
                  aria-hidden="true"
                >
                  <span
                    className="block h-full rounded-full bg-amber-400"
                    style={{ width: `${(count / maxBar) * 100}%` }}
                  />
                </span>
                <span className="w-10 shrink-0 text-right text-slate-600 dark:text-slate-400">
                  {count}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Recent comments
        </h3>
        {items.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            No written feedback yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Stars value={item.stars} />
                  <span className="text-xs text-slate-400 dark:text-slate-500">
                    <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                  </span>
                </div>
                {item.reason && (
                  <p className="mt-1.5 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">
                    {item.reason}
                  </p>
                )}
                <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">
                  {item.user?.fullName ?? 'Unknown'}
                  {item.appVersion ? ` · ${item.appVersion}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}

        {cursor && (
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {loadingMore && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            Load more
          </button>
        )}
      </div>
    </div>
  );
}

export default function FeedbackReview() {
  const [tab, setTab] = useState('feedback');

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 sm:text-2xl">
          Feedback &amp; ratings
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Bug reports and suggestions from users, and how they rate the portal.
        </p>
      </header>

      <div role="tablist" aria-label="Sections" className="flex gap-2 border-b border-slate-200 dark:border-slate-700">
        {[
          ['feedback', 'Reports'],
          ['ratings', 'Ratings'],
        ].map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`min-h-11 border-b-2 px-4 py-2 text-sm font-medium transition ${
              tab === key
                ? 'border-[#006633] text-[#006633] dark:border-green-400 dark:text-green-400'
                : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/*
        Unmounting the inactive tab is deliberate: keeping both mounted
        would fire both sets of requests on every visit, and the ratings
        summary is the more expensive of the two.
      */}
      {tab === 'feedback' ? <FeedbackTab /> : <RatingsTab />}
    </div>
  );
}
