/**
 * Push notification opt-in card.
 *
 * Renders nothing at all on browsers without Push support (notably iOS
 * Safari outside an installed PWA) — a toggle that can't work is worse
 * than no toggle.
 */

import { Bell, BellOff, AlertCircle } from 'lucide-react';

import { usePushNotifications } from '../hooks/usePushNotifications.js';
import { Spinner } from './Spinner.jsx';

export default function NotificationSettings() {
  const { supported, subscribed, blocked, busy, error, subscribe, unsubscribe } =
    usePushNotifications();

  if (!supported) return null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 rounded-lg p-2 ${
            subscribed
              ? 'bg-[#006633]/10 text-[#006633]'
              : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
          }`}
          aria-hidden="true"
        >
          {subscribed ? <Bell size={18} /> : <BellOff size={18} />}
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-slate-900 dark:text-white">Push notifications</h2>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
            Get an alert when your report changes status or someone replies — even when the
            portal is closed.
          </p>

          {blocked && (
            <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              {/* Permission can't be re-requested from script once denied,
                  so pointing at browser settings is the only honest advice. */}
              Notifications are blocked for this site. Allow them in your browser&apos;s site
              settings, then reload this page.
            </p>
          )}

          {error && !blocked && (
            <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          {!blocked && (
            <button
              type="button"
              onClick={subscribed ? unsubscribe : subscribe}
              disabled={busy}
              className={`mt-4 flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60 ${
                subscribed
                  ? 'border border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800'
                  : 'bg-[#006633] text-white hover:brightness-110'
              }`}
            >
              {busy && <Spinner size="sm" />}
              {subscribed ? 'Turn off notifications' : 'Enable notifications'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
