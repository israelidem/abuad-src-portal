/**
 * Loading indicators.
 *
 * `label` is rendered for screen readers even when visually hidden, so a
 * loading state is never silent to assistive technology.
 */

const SIZES = {
  sm: 'h-4 w-4 border-2',
  md: 'h-8 w-8 border-2',
  lg: 'h-12 w-12 border-[3px]',
};

export function Spinner({ size = 'md', className = '' }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-block animate-spin rounded-full border-current border-t-transparent ${SIZES[size]} ${className}`}
    />
  );
}

/** Centred spinner for a route that hasn't resolved yet. */
export function FullPageSpinner({ label = 'Loading…' }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
      <Spinner size="lg" className="text-[#006633]" />
      <p className="text-sm text-slate-500 dark:text-slate-400">{label}</p>
    </div>
  );
}

/**
 * Skeleton placeholder.
 *
 * Preferred over a spinner for lists — it holds the layout so content
 * doesn't jump when it arrives.
 */
export function Skeleton({ className = '' }) {
  return <div className={`animate-pulse rounded bg-slate-200 dark:bg-slate-700${className}`} aria-hidden="true" />;
}

export function TicketCardSkeleton() {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 flex items-center gap-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-16" />
      </div>
      <Skeleton className="mb-2 h-4 w-full" />
      <Skeleton className="mb-2 h-4 w-11/12" />
      <Skeleton className="h-4 w-2/3" />
      <div className="mt-4 flex gap-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-20" />
      </div>
    </div>
  );
}
