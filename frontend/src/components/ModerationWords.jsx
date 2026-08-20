/**
 * Blocked-word management.
 *
 * The filter ships with a built-in list, but campus slang and targeted
 * harassment change faster than a deploy cycle. This screen lets an admin add
 * a term and have it enforced on the next comment — no redeploy, no restart.
 *
 * Only admin-added terms are listed. The built-in list is deliberately not
 * exposed or editable here: rendering it would publish the entire filter to
 * anyone who gains an admin session, and allowing "disable" on it would turn
 * this page into a one-click way to switch moderation off. Admins manage
 * their own additions and nothing else.
 */

import { useCallback, useEffect, useState } from 'react';
import { Ban, Loader2, Plus, Trash2 } from 'lucide-react';

import { adminApi } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { Spinner } from './Spinner.jsx';

/**
 * Must match the ModerationCategory enum in adminRoutes.js exactly.
 *
 * These are the database's uppercase values, not the engine's internal
 * camelCase category keys — sending 'selfHarm' here instead of 'SELF_HARM'
 * is rejected by the schema, so the two vocabularies must not be confused.
 */
const CATEGORIES = [
  { value: 'PROFANITY', label: 'Profanity' },
  { value: 'HATE_SPEECH', label: 'Hate speech' },
  { value: 'SEXUAL', label: 'Sexual content' },
  { value: 'THREAT', label: 'Threat / violence' },
  { value: 'SELF_HARM', label: 'Self-harm' },
  { value: 'HARASSMENT', label: 'Harassment' },
  { value: 'CUSTOM', label: 'Other' },
];

const SEVERITIES = [
  { value: 'low', label: 'Low — needs two hits to flag' },
  { value: 'medium', label: 'Medium — flags, stays visible' },
  { value: 'high', label: 'High — flags and hides immediately' },
];

export default function ModerationWords() {
  const toast = useToast();

  const [words, setWords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ term: '', category: 'CUSTOM', severity: 'medium' });

  const load = useCallback(async (signal) => {
    try {
      const data = await adminApi.moderationWords({ signal });
      setWords(data.words ?? []);
      setError('');
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError(err.displayMessage ?? err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const { word } = await adminApi.addModerationWord({
        term: form.term.trim(),
        category: form.category,
        severity: form.severity,
      });

      // Prepend: the term just added is the one the admin wants to see.
      setWords((prev) => [word, ...prev]);
      setForm({ term: '', category: 'CUSTOM', severity: 'medium' });
      setAdding(false);
      toast.success('Term added. It applies to the next comment posted.');
    } catch (err) {
      // The server rejects terms shorter than 3 normalised characters and
      // duplicates; both arrive here as a readable message.
      toast.error(err.displayMessage ?? err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (word) => {
    setBusyId(word.id);
    try {
      const { word: updated } = await adminApi.updateModerationWord(word.id, {
        isEnabled: !word.isEnabled,
      });
      setWords((prev) => prev.map((w) => (w.id === word.id ? { ...w, ...updated } : w)));
      toast.success(updated.isEnabled ? 'Term re-enabled.' : 'Term disabled.');
    } catch (err) {
      toast.error(err.displayMessage ?? err.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (word) => {
    if (!window.confirm(`Delete "${word.term}" from the blocked list?`)) return;

    setBusyId(word.id);
    try {
      await adminApi.removeModerationWord(word.id);
      setWords((prev) => prev.filter((w) => w.id !== word.id));
      toast.success('Term deleted.');
    } catch (err) {
      toast.error(err.displayMessage ?? err.message);
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm text-slate-600 dark:text-slate-400">
          Comments are checked against a built-in list plus anything you add here.
          Matching ignores capitalisation, spacing, punctuation and common letter
          swaps, so you only need the plain spelling.
        </p>

        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg bg-[#006633] px-4 py-2 text-sm font-semibold text-white hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006633] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
          >
            <Plus size={16} aria-hidden="true" />
            Add term
          </button>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {adding && (
        <form
          onSubmit={submit}
          className="mb-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <label
                htmlFor="new-term"
                className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Word or phrase
              </label>
              <input
                id="new-term"
                type="text"
                value={form.term}
                onChange={(e) => setForm((f) => ({ ...f, term: e.target.value }))}
                required
                minLength={3}
                maxLength={100}
                autoComplete="off"
                placeholder="e.g. a slur being used against students"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              <p id="term-help" className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Phrases are allowed. Very short terms are rejected because they
                would match inside ordinary words.
              </p>
            </div>

            <div>
              <label
                htmlFor="new-category"
                className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Category
              </label>
              <select
                id="new-category"
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2">
              <label
                htmlFor="new-severity"
                className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Severity
              </label>
              <select
                id="new-severity"
                value={form.severity}
                onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                {SEVERITIES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={saving}
              className="flex min-h-11 items-center gap-2 rounded-lg bg-[#006633] px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
            >
              {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              Save term
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setForm({ term: '', category: 'CUSTOM', severity: 'medium' });
              }}
              className="min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium dark:border-slate-700 dark:text-slate-200"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {words.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center dark:border-slate-800 dark:bg-slate-900">
          <Ban size={32} className="mx-auto mb-3 text-slate-400" aria-hidden="true" />
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
            No custom terms yet.
          </p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            The built-in list is still active. Add a term when something slips past it.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {words.map((word) => {
            const busy = busyId === word.id;

            return (
              <li key={word.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate font-mono text-sm ${
                      word.isEnabled
                        ? 'text-slate-900 dark:text-slate-100'
                        : 'text-slate-400 line-through dark:text-slate-500'
                    }`}
                  >
                    {word.term}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {CATEGORIES.find((c) => c.value === word.category)?.label ?? word.category}
                    {' · '}
                    {word.severity}
                    {word.createdBy ? ` · added by ${word.createdBy.fullName}` : ''}
                  </p>
                </div>

                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => toggle(word)}
                    disabled={busy}
                    className="min-h-11 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    {word.isEnabled ? 'Disable' : 'Enable'}
                  </button>

                  <button
                    type="button"
                    onClick={() => remove(word)}
                    disabled={busy}
                    aria-label={`Delete ${word.term}`}
                    className="flex min-h-11 items-center gap-1.5 rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/30"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
