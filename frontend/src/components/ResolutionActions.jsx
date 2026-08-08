/**
 * Post-resolution actions for the reporter: rate it, or say it isn't fixed.
 *
 * Only rendered on the reporter's own resolved tickets. Both actions are
 * theirs alone — staff marking their own work as satisfactory would make
 * the rating meaningless.
 */

import { useState } from 'react';

import { ticketApi } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { Spinner } from './Spinner.jsx';

const SCORE_LABELS = {
  1: 'Not resolved at all',
  2: 'Poor',
  3: 'Okay',
  4: 'Good',
  5: 'Excellent',
};

function StarRating({ value, onChange, disabled }) {
  const [hovered, setHovered] = useState(0);
  const active = hovered || value;

  return (
    <div
      className="flex items-center gap-1"
      role="radiogroup"
      aria-label="Satisfaction rating"
      onMouseLeave={() => setHovered(0)}
    >
      {[1, 2, 3, 4, 5].map((score) => (
        <button
          key={score}
          type="button"
          role="radio"
          aria-checked={value === score}
          aria-label={`${score} of 5 — ${SCORE_LABELS[score]}`}
          disabled={disabled}
          onMouseEnter={() => setHovered(score)}
          onFocus={() => setHovered(score)}
          onClick={() => onChange(score)}
          className={`text-2xl transition ${
            score <= active ? 'text-amber-400' : 'text-slate-300 dark:text-slate-600'
          } ${disabled ? 'cursor-not-allowed' : 'hover:scale-110'}`}
        >
          ★
        </button>
      ))}

      {active > 0 && (
        <span className="ml-2 text-sm text-slate-600 dark:text-slate-400">
          {SCORE_LABELS[active]}
        </span>
      )}
    </div>
  );
}

export default function ResolutionActions({ ticket, onChanged }) {
  const toast = useToast();

  const [score, setScore] = useState(0);
  const [comment, setComment] = useState('');
  const [rated, setRated] = useState(Boolean(ticket.rating));
  const [submitting, setSubmitting] = useState(false);

  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  const [showReopen, setShowReopen] = useState(false);

  // Staff and passers-by get nothing here; this is the reporter's call.
  if (!ticket.isOwnTicket) return null;
  if (!['RESOLVED', 'CLOSED'].includes(ticket.status)) return null;

  const submitRating = async (event) => {
    event.preventDefault();
    if (!score) return;

    setSubmitting(true);
    try {
      await ticketApi.rate(ticket.id, score, comment.trim() || undefined);
      setRated(true);
      toast.success('Thank you — your feedback helps the SRC improve.');
    } catch (err) {
      // A 409 means it was already rated, which is a success from the
      // student's point of view, not an error to shout about.
      if (err.status === 409) {
        setRated(true);
        toast.info('You have already rated this report.');
      } else {
        toast.error(err.displayMessage);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const submitReopen = async (event) => {
    event.preventDefault();
    if (reason.trim().length < 5) return;

    setReopening(true);
    try {
      const { ticket: updated } = await ticketApi.reopen(ticket.id, reason.trim());
      toast.success('Reopened. The team handling it has been notified.');
      setShowReopen(false);
      setReason('');
      onChanged?.(updated);
    } catch (err) {
      toast.error(err.displayMessage);
    } finally {
      setReopening(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <h3 className="font-semibold text-slate-900 dark:text-white">
        {rated ? 'Thanks for your feedback' : 'How was this handled?'}
      </h3>

      {!rated ? (
        <form onSubmit={submitRating} className="mt-4 space-y-4">
          <StarRating value={score} onChange={setScore} disabled={submitting} />

          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Anything you'd like to add? (optional)"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
          />

          <button
            type="submit"
            disabled={!score || submitting}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? <Spinner size="sm" /> : 'Submit rating'}
          </button>
        </form>
      ) : (
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          Your rating has been recorded.
        </p>
      )}

      <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
        {!showReopen ? (
          <button
            type="button"
            onClick={() => setShowReopen(true)}
            className="text-sm font-medium text-amber-700 hover:underline dark:text-amber-400"
          >
            Still not fixed? Reopen this report
          </button>
        ) : (
          <form onSubmit={submitReopen} className="space-y-3">
            <label
              htmlFor="reopen-reason"
              className="block text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              What is still wrong?
            </label>
            <textarea
              id="reopen-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              required
              placeholder="Tell the team what still needs attention…"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
            />

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={reason.trim().length < 5 || reopening}
                className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-amber-700 disabled:opacity-50"
              >
                {reopening ? <Spinner size="sm" /> : 'Reopen report'}
              </button>
              <button
                type="button"
                onClick={() => setShowReopen(false)}
                className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
