/**
 * §10 — the in-app rating prompt.
 *
 * Three rules from the brief drive the whole design:
 *
 *   "not immediately after login"  — a delay before it can appear at all.
 *   "not repeatedly annoy users"   — one answer closes the subject for
 *                                    months, and a dismissal counts as an
 *                                    answer.
 *   "across sessions/devices"      — so the decision cannot live in
 *                                    localStorage. The server owns it
 *                                    (GET /ratings/state); clearing site
 *                                    data or switching phone changes
 *                                    nothing.
 *
 * localStorage is still used, but only as a *second* gate on top of the
 * server's: it suppresses the prompt for the rest of the day after a
 * dismissal so a user who closes it and keeps browsing is not asked again
 * in the same afternoon while the server round-trip is still cached.
 *
 * Accessibility follows the same pattern as ContactDeveloper: role=dialog,
 * aria-modal, focus moved in on open, Tab cycles inside, Escape closes,
 * focus restored on close.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Star, X, Loader2 } from 'lucide-react';

import { feedbackApi } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';

/**
 * How long the user must be actively in the app before the prompt appears.
 *
 * This is the "not immediately after login" gate. The server separately
 * requires the account to be at least three days old; this timer is the
 * within-session half — appearing 90 seconds into a visit means the user
 * has actually done something, not just landed on the dashboard.
 *
 * The timer only runs while the tab is visible, so leaving a tab open in
 * the background does not silently satisfy it.
 */
const VISIBLE_MS_BEFORE_PROMPT = 90_000;

/** Local key holding a timestamp; suppresses re-showing on the same day. */
const SNOOZE_KEY = 'abuad.rating.snoozeUntil';

const readSnooze = () => {
  try {
    const raw = window.localStorage.getItem(SNOOZE_KEY);
    return raw ? Number(raw) : 0;
  } catch {
    // Private mode / storage disabled. Falling back to 0 means the server
    // gate alone decides, which is the correct degradation.
    return 0;
  }
};

const writeSnooze = (until) => {
  try {
    window.localStorage.setItem(SNOOZE_KEY, String(until));
  } catch {
    /* Non-fatal: the server still prevents a duplicate submission. */
  }
};

export default function RatingPrompt() {
  const { user } = useAuth();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [stars, setStars] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const dialogRef = useRef(null);
  const firstStarRef = useRef(null);
  const openerRef = useRef(null);

  /**
   * Decide whether to show, then arm a timer.
   *
   * The server call happens once per mount and only for signed-in users.
   * It is a single indexed lookup, so this is not the notification-polling
   * mistake — there is no interval here.
   */
  useEffect(() => {
    if (!user) return undefined;
    if (Date.now() < readSnooze()) return undefined;

    let cancelled = false;
    let timer = null;
    let visibleMs = 0;
    let lastTick = Date.now();

    const controller = new AbortController();

    const arm = () => {
      /**
       * Accumulate only visible time.
       *
       * A plain setTimeout would fire for a tab left open in another
       * window, so the prompt would be waiting on a page the user never
       * looked at. Counting in one-second ticks while visible is closer to
       * "has used the portal for a while".
       */
      timer = setInterval(() => {
        if (document.visibilityState !== 'visible') {
          lastTick = Date.now();
          return;
        }
        const now = Date.now();
        visibleMs += now - lastTick;
        lastTick = now;

        if (visibleMs >= VISIBLE_MS_BEFORE_PROMPT) {
          clearInterval(timer);
          timer = null;
          if (!cancelled) {
            // Remember what had focus, to restore it on close.
            openerRef.current = document.activeElement;
            setOpen(true);
          }
        }
      }, 1_000);
    };

    feedbackApi
      .ratingState({ signal: controller.signal })
      .then((state) => {
        if (!cancelled && state?.shouldPrompt) arm();
      })
      .catch(() => {
        /**
         * Silent by design. If the state check fails the prompt simply
         * never appears — an unavailable endpoint must not produce an
         * error toast for a feature the user did not ask for.
         */
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [user]);

  const close = useCallback(() => {
    setOpen(false);
    const opener = openerRef.current;
    if (opener instanceof HTMLElement && document.contains(opener)) {
      opener.focus();
    }
  }, []);

  /** Focus management, Escape, Tab cycling, and scroll lock while open. */
  useEffect(() => {
    if (!open) return undefined;

    firstStarRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        // Escape is a dismissal, not a silent close: record it so the
        // prompt does not reappear on the next page view.
        void dismiss();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const send = async (payload) => {
    setSubmitting(true);
    try {
      await feedbackApi.submitRating({
        ...payload,
        appVersion: import.meta.env.VITE_APP_VERSION || undefined,
      });
      return true;
    } catch (err) {
      /**
       * 409 means the server already has an answer for this round — a
       * double submit, or another tab got there first. That is not a
       * failure the user needs to see, so close quietly.
       */
      if (err.status === 409) return true;
      toast.error(err.displayMessage || 'Could not save your rating.');
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const dismiss = async () => {
    // Snooze locally first, so closing feels instant even if the request
    // is slow, and so a failed request still stops the nagging today.
    writeSnooze(Date.now() + 24 * 60 * 60 * 1000);
    close();
    await send({ dismissed: true });
  };

  const submit = async (event) => {
    event.preventDefault();
    if (stars < 1) return;

    const ok = await send({
      stars,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });

    if (ok) {
      writeSnooze(Date.now() + 24 * 60 * 60 * 1000);
      close();
      toast.success('Thank you for the feedback.');
    }
  };

  if (!open) return null;

  const shown = hovered || stars;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
      // Clicking the backdrop dismisses, matching the X — anything that
      // closes the prompt must record the dismissal, or the next page view
      // shows it again.
      onClick={dismiss}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rating-prompt-title"
        aria-describedby="rating-prompt-desc"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-800 sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              id="rating-prompt-title"
              className="text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              How is the SRC portal working for you?
            </h2>
            <p
              id="rating-prompt-desc"
              className="mt-1 text-sm text-slate-600 dark:text-slate-400"
            >
              One quick rating helps us decide what to fix next.
            </p>
          </div>

          <button
            type="button"
            onClick={dismiss}
            aria-label="Not now"
            className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006633] dark:text-slate-400 dark:hover:bg-slate-700"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={submit} className="mt-4">
          {/*
            radiogroup rather than five bare buttons: a screen reader then
            announces "3 of 5 stars, radio, 3 of 5" instead of five
            unrelated buttons, and the selected value is conveyed without
            relying on colour.
          */}
          <div
            role="radiogroup"
            aria-labelledby="rating-prompt-title"
            className="flex items-center justify-center gap-1 py-2"
            onMouseLeave={() => setHovered(0)}
          >
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                ref={value === 1 ? firstStarRef : undefined}
                type="button"
                role="radio"
                aria-checked={stars === value}
                aria-label={`${value} ${value === 1 ? 'star' : 'stars'}`}
                onClick={() => setStars(value)}
                onMouseEnter={() => setHovered(value)}
                onFocus={() => setHovered(value)}
                // h-12 w-12 — comfortably past the 44px touch minimum, which
                // matters here because five targets sit side by side on a
                // narrow phone.
                className="flex h-12 w-12 items-center justify-center rounded-lg transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006633] dark:hover:bg-slate-700"
              >
                <Star
                  size={28}
                  aria-hidden="true"
                  className={
                    value <= shown
                      ? 'fill-amber-400 text-amber-400'
                      : 'text-slate-300 dark:text-slate-600'
                  }
                />
              </button>
            ))}
          </div>

          {/*
            The reason field appears only after a rating is chosen. Showing
            it upfront makes a one-tap interaction look like a form and is
            the main reason these prompts get dismissed unanswered.
          */}
          {stars > 0 && (
            <div className="mt-3">
              <label
                htmlFor="rating-reason"
                className="block text-sm font-medium text-slate-900 dark:text-slate-100"
              >
                {stars <= 3 ? 'What went wrong?' : 'Anything we should know?'}{' '}
                <span className="font-normal text-slate-500 dark:text-slate-400">
                  (optional)
                </span>
              </label>
              <textarea
                id="rating-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder={
                  stars <= 3
                    ? 'Tell us what was frustrating.'
                    : 'Anything you would like to see added.'
                }
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633] dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
          )}

          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={dismiss}
              disabled={submitting}
              className="flex min-h-11 items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006633] disabled:opacity-60 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              Not now
            </button>
            <button
              type="submit"
              // Disabled until a star is chosen: submitting zero stars would
              // be indistinguishable from a dismissal in the data.
              disabled={stars < 1 || submitting}
              className="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#006633] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#005229] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006633] focus-visible:ring-offset-2 disabled:opacity-60"
            >
              {submitting && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
              Submit rating
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
