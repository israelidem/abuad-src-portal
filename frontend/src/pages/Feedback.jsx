/**
 * §9 — "Report a problem with the portal".
 *
 * Kept deliberately distinct from raising a ticket, because the two are
 * easy to confuse and the confusion is expensive: a ticket is an SRC
 * complaint routed to a department and answered by staff, while this is a
 * bug report about the software and goes to whoever maintains it. The
 * copy at the top of the form says so, and the empty state links to the
 * ticket form for anyone who arrived here by mistake.
 *
 * The page also lists the user's own recent submissions. Without it the
 * form is a black hole — people re-report the same bug because nothing
 * acknowledged the first one.
 */

import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquarePlus, Lightbulb, Bug, Wrench, HelpCircle, Send, Loader2 } from 'lucide-react';

import { feedbackApi } from '../lib/api.js';
import { uploadAttachment, validateFile } from '../lib/uploads.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Spinner } from '../components/Spinner.jsx';

/**
 * Category values must match FEEDBACK_CATEGORIES in the backend validator,
 * which in turn matches the SQL CHECK constraint. A typo here is a 400 the
 * user cannot fix, so the list is short and copied deliberately.
 */
const CATEGORIES = [
  { value: 'BUG', label: 'Something is broken', icon: Bug, hint: 'A feature that does not work as expected' },
  { value: 'TECHNICAL', label: 'Technical issue', icon: Wrench, hint: 'Errors, slowness, pages not loading' },
  { value: 'USABILITY', label: 'Hard to use', icon: HelpCircle, hint: 'Confusing layout, hard to find something' },
  { value: 'SUGGESTION', label: 'Suggestion', icon: Lightbulb, hint: 'An idea for improving the portal' },
  { value: 'GENERAL', label: 'General feedback', icon: MessageSquarePlus, hint: 'Anything else' },
  { value: 'OTHER', label: 'Other', icon: MessageSquarePlus, hint: '' },
];

const STATUS_STYLES = {
  NEW: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  IN_REVIEW: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  RESOLVED: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  CLOSED: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
};

const STATUS_LABELS = {
  NEW: 'New',
  IN_REVIEW: 'In review',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

export default function Feedback() {
  const { user } = useAuth();
  const toast = useToast();

  const [category, setCategory] = useState('BUG');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [screenshot, setScreenshot] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  const [mine, setMine] = useState([]);
  const [loadingMine, setLoadingMine] = useState(true);

  const loadMine = useCallback(async (signal) => {
    try {
      const data = await feedbackApi.mine({ signal });
      setMine(data.items);
    } catch (err) {
      // An unmount mid-flight is not a failure worth a toast.
      if (err.name !== 'AbortError') setMine([]);
    } finally {
      if (!signal?.aborted) setLoadingMine(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadMine(controller.signal);
    return () => controller.abort();
  }, [loadMine]);

  const handleFile = (event) => {
    const file = event.target.files?.[0];
    // Reset immediately so re-picking the same file after an error fires
    // another change event.
    event.target.value = '';
    if (!file) return;

    /**
     * Validate before upload, not after.
     *
     * The server signature already constrains format and size, so this is
     * a courtesy — but it turns a rejected upload into an instant message
     * instead of a wasted round-trip on a phone connection.
     */
    const error = validateFile(file);
    if (error) {
      toast.error(error);
      return;
    }
    setScreenshot(file);
  };

  const submit = async (event) => {
    event.preventDefault();
    setFieldErrors({});

    /**
     * Client-side length checks mirror the Zod schema so the common
     * mistakes are caught without a round-trip. The server remains the
     * authority — these are not a substitute for it.
     */
    const errors = {};
    if (subject.trim().length < 5) errors.subject = 'Please write at least 5 characters.';
    if (description.trim().length < 10) errors.description = 'Please describe the problem in at least 10 characters.';
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    let uploadedPath = null;

    try {
      if (screenshot) {
        // Screenshots of a portal bug are not sensitive in the way an
        // anonymous ticket is, so this uses the normal per-user folder.
        const result = await uploadAttachment(screenshot, user.id);
        uploadedPath = result.storagePath;
      }

      await feedbackApi.submit({
        category,
        subject: subject.trim(),
        description: description.trim(),
        ...(uploadedPath ? { screenshotPath: uploadedPath } : {}),
        /**
         * Page URL and app version are diagnostic gold and cost the user
         * nothing to provide. The user agent is deliberately NOT sent — the
         * server reads it from the request header, where it cannot be
         * spoofed by a modified client.
         */
        pageUrl: window.location.href.slice(0, 500),
        appVersion: import.meta.env.VITE_APP_VERSION || undefined,
      });

      toast.success('Thank you — your report has been sent.');
      setSubject('');
      setDescription('');
      setScreenshot(null);
      setCategory('BUG');
      loadMine();
    } catch (err) {
      /**
       * A failed submit after a successful upload would otherwise leave the
       * image in Cloudinary with nothing referencing it. Best-effort
       * cleanup; removeAttachment already swallows its own errors, since
       * failing to tidy up must not replace the real error message.
       */
      if (uploadedPath) {
        const { removeAttachment } = await import('../lib/uploads.js');
        removeAttachment(uploadedPath);
      }

      if (err.status === 429) {
        toast.error(err.message);
      } else {
        setFieldErrors(err.fieldErrors || {});
        toast.error(err.displayMessage || 'Could not send your report.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const selected = CATEGORIES.find((c) => c.value === category);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 sm:text-2xl">
          Portal feedback
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Found a bug, or something confusing about this website? Tell us here.{' '}
          {/* The distinction that stops this queue filling with SRC complaints. */}
          To raise a complaint for the SRC to act on,{' '}
          <Link
            to="/tickets/new"
            className="font-medium text-[#006633] underline decoration-dotted underline-offset-2 hover:no-underline dark:text-green-400"
          >
            submit a ticket instead
          </Link>
          .
        </p>
      </header>

      <form
        onSubmit={submit}
        noValidate
        className="space-y-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-6"
      >
        <fieldset>
          <legend className="text-sm font-medium text-slate-900 dark:text-slate-100">
            What kind of feedback is this?
          </legend>

          {/*
            Radio inputs rather than a <select>: five options are worth
            showing at once on mobile, and radios are keyboard-navigable
            with arrow keys for free. The input is visually hidden but
            present, so screen readers and focus rings still work.
          */}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {CATEGORIES.map(({ value, label, icon: Icon, hint }) => (
              <label
                key={value}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-left transition focus-within:ring-2 focus-within:ring-[#006633] ${
                  category === value
                    ? 'border-[#006633] bg-[#006633]/5 dark:border-green-400 dark:bg-green-400/10'
                    : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
                }`}
              >
                <input
                  type="radio"
                  name="category"
                  value={value}
                  checked={category === value}
                  onChange={() => setCategory(value)}
                  className="sr-only"
                />
                <Icon
                  size={18}
                  aria-hidden="true"
                  className={
                    category === value
                      ? 'mt-0.5 shrink-0 text-[#006633] dark:text-green-400'
                      : 'mt-0.5 shrink-0 text-slate-400'
                  }
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                    {label}
                  </span>
                  {hint && (
                    <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                      {hint}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label
            htmlFor="feedback-subject"
            className="block text-sm font-medium text-slate-900 dark:text-slate-100"
          >
            Summary
          </label>
          <input
            id="feedback-subject"
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={140}
            required
            // aria-describedby wires the error to the input, so a screen
            // reader announces it on focus rather than leaving it as
            // unattached red text.
            aria-describedby={fieldErrors.subject ? 'feedback-subject-error' : undefined}
            aria-invalid={fieldErrors.subject ? 'true' : undefined}
            placeholder={
              selected?.value === 'SUGGESTION'
                ? 'e.g. Let students filter tickets by department'
                : 'e.g. Notification bell missing on my phone'
            }
            className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633] dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
          {fieldErrors.subject && (
            <p id="feedback-subject-error" role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
              {fieldErrors.subject}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="feedback-description"
            className="block text-sm font-medium text-slate-900 dark:text-slate-100"
          >
            Details
          </label>
          <textarea
            id="feedback-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
            maxLength={4000}
            required
            aria-describedby={
              fieldErrors.description ? 'feedback-description-error' : 'feedback-description-hint'
            }
            aria-invalid={fieldErrors.description ? 'true' : undefined}
            placeholder="What did you do, what happened, and what did you expect instead?"
            className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633] dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
          {fieldErrors.description ? (
            <p id="feedback-description-error" role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
              {fieldErrors.description}
            </p>
          ) : (
            <p id="feedback-description-hint" className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              {description.length}/4000 characters. Which page and which device helps a lot.
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="feedback-screenshot"
            className="block text-sm font-medium text-slate-900 dark:text-slate-100"
          >
            Screenshot <span className="font-normal text-slate-500 dark:text-slate-400">(optional)</span>
          </label>
          <input
            id="feedback-screenshot"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic"
            onChange={handleFile}
            className="mt-1.5 block w-full text-sm text-slate-600 file:mr-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-slate-100 file:px-4 file:py-2.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200 dark:text-slate-400 dark:file:bg-slate-700 dark:file:text-slate-200"
          />
          {screenshot && (
            <p className="mt-1.5 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              <span className="truncate">{screenshot.name}</span>
              <button
                type="button"
                onClick={() => setScreenshot(null)}
                className="shrink-0 font-medium text-red-600 hover:underline dark:text-red-400"
              >
                Remove
              </button>
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={submitting}
          // min-h-11 keeps the touch target at the 44px minimum on mobile.
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#006633] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#005229] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006633] focus-visible:ring-offset-2 disabled:opacity-60 sm:w-auto"
        >
          {submitting ? (
            <>
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              Sending…
            </>
          ) : (
            <>
              <Send size={16} aria-hidden="true" />
              Send feedback
            </>
          )}
        </button>
      </form>

      <section aria-labelledby="my-feedback-heading">
        <h2
          id="my-feedback-heading"
          className="text-sm font-semibold text-slate-900 dark:text-slate-100"
        >
          Your recent reports
        </h2>

        {loadingMine ? (
          <div className="mt-3 flex justify-center py-6">
            <Spinner />
          </div>
        ) : mine.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Nothing yet. Anything you send will appear here with its status.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {mine.map((item) => (
              <li
                key={item.id}
                className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800"
              >
                <div className="flex items-start justify-between gap-3">
                  {/*
                    Rendered as text, never as HTML. React escapes by
                    default, so a report whose subject contains a <script>
                    tag displays the characters rather than executing —
                    which is exactly what should happen to text a user
                    typed.
                  */}
                  <p className="min-w-0 flex-1 text-sm font-medium text-slate-900 dark:text-slate-100">
                    {item.subject}
                  </p>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      STATUS_STYLES[item.status] || STATUS_STYLES.NEW
                    }`}
                  >
                    {STATUS_LABELS[item.status] || item.status}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-slate-600 dark:text-slate-400">
                  {item.description}
                </p>
                <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">
                  <time dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleDateString(undefined, {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </time>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
