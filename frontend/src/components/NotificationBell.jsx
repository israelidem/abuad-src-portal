/**
 * Header notification bell.
 *
 * Polls rather than holding a socket open: Render's free tier idles and
 * drops long-lived connections, so a 60s poll is both cheaper and more
 * reliable here. Realtime is a later phase.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Check } from 'lucide-react';

import { notificationApi } from '../lib/api.js';

const POLL_MS = 60_000;

/** "3h ago" — avoids pulling in a date library for one label. */
function timeAgo(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const units = [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
  ];
  for (const [label, size] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${label} ago`;
  }
  return 'just now';
}

export default function NotificationBell() {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const load = useCallback(async (signal) => {
    try {
      const data = await notificationApi.list({ limit: 8 }, { signal });
      setItems(data.notifications ?? []);
      setUnread(data.unreadCount ?? 0);
    } catch {
      // A failed poll is not worth a toast — the bell just stays as it was.
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    // Wrapped rather than called bare: setState must not run synchronously
    // during the effect, or React re-renders in a cascade before the first
    // paint settles.
    void (async () => {
      await load(controller.signal);
    })();

    // Background tabs are throttled hard by every modern browser —
    // setInterval can be held to once a minute or stopped altogether, and
    // a phone with the PWA backgrounded may not run it for far longer.
    // Polling alone therefore meant returning to the tab and seeing a
    // stale bell for up to a minute, which is what "notifications don't
    // arrive" actually looked like most of the time.
    //
    // Refetching whenever the tab becomes visible again closes that gap:
    // the moment a student looks at the page, what they see is current.
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load(controller.signal);
    }, POLL_MS);

    const onVisible = () => {
      if (document.visibilityState === 'visible') load(controller.signal);
    };

    document.addEventListener('visibilitychange', onVisible);
    // Covers alt-tab back to an already-visible tab, where
    // visibilitychange does not fire.
    window.addEventListener('focus', onVisible);

    // A push arriving is the strongest possible signal that the bell is
    // out of date. The service worker forwards a message on every push,
    // so an open tab updates immediately instead of waiting for the poll.
    const onSwMessage = (event) => {
      if (event.data?.type === 'notification') load(controller.signal);
    };
    navigator.serviceWorker?.addEventListener('message', onSwMessage);

    return () => {
      controller.abort();
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      navigator.serviceWorker?.removeEventListener('message', onSwMessage);
    };
  }, [load]);

  // Close on outside click and on Escape — a dropdown that traps the user
  // is worse than no dropdown.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const markAll = async () => {
    // Optimistic: the badge should clear the instant it's clicked.
    setUnread(0);
    setItems((prev) => prev.map((n) => ({ ...n, isRead: true })));
    try {
      await notificationApi.markAllRead();
    } catch {
      load();
    }
  };

  const openItem = async (notification) => {
    setOpen(false);
    if (notification.isRead) return;

    setUnread((n) => Math.max(0, n - 1));
    setItems((prev) =>
      prev.map((n) => (n.id === notification.id ? { ...n, isRead: true } : n))
    );
    await notificationApi.markRead(notification.id).catch(() => {});
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        // min-h/min-w 44px: the icon is 18px and p-2 gave a ~34px target,
        // below the 44px minimum that makes a control reliably tappable
        // with a thumb. Desktop is unaffected — the box was already
        // larger than the glyph.
        className="relative flex h-11 w-11 items-center justify-center rounded-lg text-white/75 hover:bg-white/10 hover:text-white"
        aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'}

        aria-expanded={open}
        aria-haspopup="true"
      >
        <Bell size={18} />
        {unread > 0 && (
          // Pulled inside the button box (right-1.5/top-1.5 rather than
          // negative offsets) so the badge cannot overlap the adjacent
          // hamburger control in the tight mobile header.
          <span className="pointer-events-none absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#FAF92A] px-1 text-[10px] font-bold text-[#006633]">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        // Width is viewport-relative below sm. A fixed w-80 (320px) is
        // exactly the width of the smallest phones in use, so with the
        // header's px-4 the panel was clipped at the screen edge and the
        // right-hand side of every notification was unreadable.
        <div
          role="region"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-2 w-[calc(100vw-2rem)] max-w-sm overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg sm:w-80 dark:border-slate-800 dark:bg-slate-900"
        >

          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Notifications</h2>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAll}
                className="flex items-center gap-1 text-xs font-medium text-[#006633] hover:underline"
              >
                <Check size={13} />
                Mark all read
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
              Nothing yet. Updates on your reports will show up here.
            </p>
          ) : (
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
              {items.map((n) => (
                <li key={n.id}>
                  <Link
                    to={n.link ?? '/dashboard'}
                    onClick={() => openItem(n)}
                    className={`block px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800 ${
                      n.isRead ? '' : 'bg-[#006633]/5'
                    }`}
                  >
                    <p className="flex items-start gap-2 text-sm font-medium text-slate-900 dark:text-white">
                      {!n.isRead && (
                        <span
                          className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#006633]"
                          aria-hidden="true"
                        />
                      )}
                      {n.title}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-600 dark:text-slate-400">{n.body}</p>
                    <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">{timeAgo(n.createdAt)}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
