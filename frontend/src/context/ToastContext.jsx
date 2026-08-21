/**
 * Toast notifications.
 *
 * Replaces the `alert()` calls scattered through the old app — those
 * block the main thread, can't be styled, and read poorly on mobile.
 *
 * The container is an aria-live region, so screen readers announce
 * messages without stealing focus.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';

const ToastContext = createContext(null);

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>.');
  return ctx;
};

const VARIANTS = {
  success: { icon: CheckCircle, className: 'border-green-200 bg-green-50 text-green-900 dark:border-green-200/20 dark:bg-green-950/40' },
  error: { icon: AlertCircle, className: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/50 dark:bg-red-950/40' },
  info: { icon: Info, className: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/40' },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  // Tracked so timers can be cleared if a toast is dismissed early
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  /**
   * `action` is an optional `{ label, onClick }`, rendered as a button
   * inside the toast. Added for the service-worker update prompt, which
   * needs to offer "Reload" rather than just stating that an update
   * exists and leaving the user to guess.
   *
   * Pass `duration: 0` alongside it — a toast with an action that
   * disappears before the user can click it is worse than none.
   */
  const show = useCallback(
    (message, variant = 'info', duration = 5000, action = null) => {
      const id = crypto.randomUUID();
      setToasts((current) => [...current, { id, message, variant, action }]);

      // Errors stay until dismissed — they usually need an action
      if (duration > 0 && variant !== 'error') {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration)
        );
      }

      return id;
    },
    [dismiss]
  );

  const value = useMemo(
    () => ({
      show,
      dismiss,
      success: (message, duration) => show(message, 'success', duration),
      error: (message, duration) => show(message, 'error', duration),
      info: (message, duration, action) => show(message, 'info', duration, action),
    }),
    [show, dismiss]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div
        role="region"
        aria-live="polite"
        aria-label="Notifications"
        /*
         * Positioning, and why it is written this way.
         *
         * It used to be `fixed bottom-4 right-4 w-full max-w-sm px-4`. On a
         * phone `max-w-sm` (24rem) is wider than the viewport, so `w-full`
         * resolved to 100vw and the box was anchored 1rem from the right —
         * putting its left edge 1rem *outside* the viewport. The toast then
         * looked shifted off-centre to the left and, because a fixed element
         * still counts towards the document's scroll width in every engine
         * except when it is clipped, the page gained a horizontal scroll.
         * The `px-4` was compensation for that, not layout.
         *
         * Now: on mobile the container is pinned to both edges
         * (`inset-x-3`), so it is exactly as wide as the space available and
         * cannot overflow in either direction whatever the viewport. From
         * `sm` up it reverts to a right-anchored column with an intrinsic
         * width, where `max-w-sm` is genuinely narrower than the viewport.
         */
        className="pointer-events-none fixed inset-x-3 bottom-3 z-50 flex flex-col gap-2 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-full sm:max-w-sm"

      >
        {toasts.map(({ id, message, variant, action }) => {
          const { icon: Icon, className } = VARIANTS[variant] ?? VARIANTS.info;
          return (
            <div
              key={id}
              className={`pointer-events-auto flex items-start gap-3 rounded-lg border p-4 shadow-lg ${className}`}
            >
              <Icon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
              <div className="flex-1">
                <p className="text-sm">{message}</p>
                {action && (
                  <button
                    type="button"
                    onClick={() => {
                      dismiss(id);
                      action.onClick();
                    }}
                    className="mt-2 text-sm font-semibold underline underline-offset-2 hover:no-underline"
                  >
                    {action.label}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(id)}
                className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
                aria-label="Dismiss notification"
              >
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
