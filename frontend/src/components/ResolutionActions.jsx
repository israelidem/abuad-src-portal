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
  /*
   * The rating already on record, or null.
   *
   * Seeded from `ticket.rating`, which the API serialises from the
   * TicketRating row for the signed-in reporter. That is what makes the
   * prompt stay gone: a refresh, a re-login or a fresh navigation all
   * re-read it from the database, so there is no local-only flag that a
   * reload could forget.
   *
   * Held in state as well so the panel can switch to the thank-you view
   * the moment the POST returns, without waiting for a re-fetch.
   */
  const [submitted, setSubmitted] = useState(ticket.rating ?? null);
  const [submitting, setSubmitting] = useState(false);

  // Prefer whatever the server last told us. `submitted` covers both the
  // seeded value and the just-posted one, so one flag drives the view.
  const rated = Boolean(submitted);


  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  const [showReopen, setShowReopen] = useState(false);

  // Staff and passers-by get nothing here; this is the reporter's call.
  if (!ticket.isOwnTicket) return null;
  if (!['RESOLVED', 'CLOSED'].includes(ticket.status)) return null;

  const submitRating = async (event) => {
    event.preventDefault();
    if (!score) return;

    const trimmed = comment.trim();

    setSubmitting(true);
    try {
      // The response carries the stored row back; keeping it means the
      // summary below shows what was actually saved rather than what was
      // typed. The `?? {...}` covers an older API that returns no body.
      const result = await ticketApi.rate(ticket.id, score, trimmed || undefined);
      setSubmitted(result?.rating ?? { score, comment: trimmed || null });
      toast.success('Thank you — your feedback helps the SRC improve.');
      // Refresh the parent so the new RATED entry appears in the activity
      // timeline immediately, instead of only after the next page load.
      onChanged?.();
    } catch (err) {
      // A 409 means it was already rated, which is a success from the
      // student's point of view, not an error to shout about.
      //
      // Reached when the same student submits twice from two tabs: the
      // unique constraint rejects the second write. Treat it as done and
      // reload so the panel shows the rating that actually won.
      if (err.status === 409) {
        setSubmitted({ score, comment: trimmed || null });
        toast.info('You have already rated this report.');
        onChanged?.();
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
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-white dark:placeholder-slate-500"
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
        /*
          Show what was recorded, not just that something was. This is the
          confirmation that the feedback landed — and if the student
          returns weeks later it answers "did I already rate this?" without
          them having to guess from the absence of a form.
        */
        <div className="mt-2 space-y-1">
          <p className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            <span className="text-amber-400" aria-hidden="true">
              {'★'.repeat(submitted.score)}
              <span className="text-slate-300 dark:text-slate-600">
                {'★'.repeat(5 - submitted.score)}
              </span>
            </span>
            <span>
              You rated this {submitted.score}/5
              {SCORE_LABELS[submitted.score] ? ` — ${SCORE_LABELS[submitted.score]}` : ''}
            </span>
          </p>
          {submitted.comment && (
            <p className="border-l-2 border-slate-200 pl-2 text-sm italic text-slate-600 dark:border-slate-800 dark:text-slate-400">
              {submitted.comment}
            </p>
          )}
        </div>
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
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-white dark:placeholder-slate-500"
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
