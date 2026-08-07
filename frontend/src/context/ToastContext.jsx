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
  success: { icon: CheckCircle, className: 'border-green-200 bg-green-50 text-green-900' },
  error: { icon: AlertCircle, className: 'border-red-200 bg-red-50 text-red-900' },
  info: { icon: Info, className: 'border-blue-200 bg-blue-50 text-blue-900' },
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

  const show = useCallback(
    (message, variant = 'info', duration = 5000) => {
      const id = crypto.randomUUID();
      setToasts((current) => [...current, { id, message, variant }]);

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
      info: (message, duration) => show(message, 'info', duration),
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
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2 px-4 sm:px-0"
      >
        {toasts.map(({ id, message, variant }) => {
          const { icon: Icon, className } = VARIANTS[variant] ?? VARIANTS.info;
          return (
            <div
              key={id}
              className={`pointer-events-auto flex items-start gap-3 rounded-lg border p-4 shadow-lg ${className}`}
            >
              <Icon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
              <p className="flex-1 text-sm">{message}</p>
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
