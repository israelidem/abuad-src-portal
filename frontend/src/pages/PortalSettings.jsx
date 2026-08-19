/**
 * Portal settings — super admin only.
 *
 * Rendered from the manifest the API serves (see
 * backend/src/config/settingsRegistry.js) rather than a hard-coded form.
 * The previous version listed every field by hand, which meant a setting
 * could exist in the database and the validator while having no control on
 * this page — editable only by hand-crafted API calls. Now adding a
 * registry entry surfaces it here automatically.
 *
 * Two things on this page can lock people out — closing registration and
 * maintenance mode — so both get a banner spelling out the consequence
 * while they are on, and the save sends only what actually changed.
 */

import { useEffect, useMemo, useState } from 'react';

import { adminApi } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { Spinner } from '../components/Spinner.jsx';

/** "a.com, b.com" -> ['a.com','b.com'] — blanks dropped, lowercased. */
const parseList = (text) =>
  text
    .split(/[,\n]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

/**
 * Fields revealed only when another setting makes them relevant.
 *
 * Deliberately a UI concern, not policy: the API validates and enforces
 * these regardless. Progressive disclosure just stops the page presenting
 * a "message shown when registration is closed" box to an admin whose
 * registration is open, which reads as a bug.
 */
const VISIBLE_WHEN = {
  signupClosedMessage: (form) => form.allowStudentSignups === false,
  allowedDomains: (form) => form.restrictSignupDomains === true,
  allowSubdomains: (form) => form.restrictSignupDomains === true,
  maintenanceMessage: (form) => form.maintenanceMode === true,
};

/** Registry value -> editable form value. */
const toFormValue = (setting, value) => {
  if (setting.type === 'domains') return (value ?? []).join(', ');
  if (setting.type === 'text') return value ?? '';
  if (setting.type === 'number') return value ?? '';
  return Boolean(value);
};

/** Editable form value -> API payload value. */
const toApiValue = (setting, value) => {
  if (setting.type === 'domains') return parseList(value);
  if (setting.type === 'number') return Number(value);
  if (setting.type === 'text') {
    const trimmed = String(value).trim();
    // Null clears a custom message so the built-in wording applies again;
    // an empty string would persist as "the message is blank".
    return trimmed === '' ? (setting.nullable ? null : '') : trimmed;
  }
  return Boolean(value);
};

const inputClass =
  'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-white';

export default function PortalSettings() {
  const toast = useToast();

  const [settings, setSettings] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  // Flat key -> definition, so a field can look itself up while rendering.
  const byKey = useMemo(() => {
    const map = {};
    for (const group of manifest ?? []) {
      for (const setting of group.settings) map[setting.key] = setting;
    }
    return map;
  }, [manifest]);

  useEffect(() => {
    const controller = new AbortController();

    adminApi
      .settings({ signal: controller.signal })
      .then(({ settings: loaded, manifest: groups }) => {
        setSettings(loaded);
        setManifest(groups ?? []);

        const next = {};
        for (const group of groups ?? []) {
          for (const setting of group.settings) {
            next[setting.key] = toFormValue(setting, loaded[setting.key]);
          }
        }
        setForm(next);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') toast.error(err.displayMessage);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const save = async (event) => {
    event.preventDefault();

    // Only what changed. The API rejects an empty patch, and sending
    // untouched fields would overwrite a concurrent change by another
    // admin with values this page loaded minutes ago.
    const patch = {};
    for (const [key, value] of Object.entries(form)) {
      const setting = byKey[key];
      if (!setting) continue;

      const apiValue = toApiValue(setting, value);
      const original = settings[key];

      const unchanged =
        setting.type === 'domains'
          ? JSON.stringify(apiValue) === JSON.stringify(original ?? [])
          : apiValue === (original ?? (setting.type === 'text' ? null : original));

      if (!unchanged) patch[key] = apiValue;
    }

    if (Object.keys(patch).length === 0) {
      toast.info('Nothing to save — no settings were changed.');
      return;
    }

    // The API refuses this too, but catching it here explains *why*
    // rather than surfacing a field-level validation error.
    if (patch.restrictSignupDomains === true) {
      const allowed = patch.allowedDomains ?? settings.allowedDomains ?? [];
      if (allowed.length === 0) {
        toast.error('Add at least one allowed domain, or turn the restriction off.');
        return;
      }
    }

    setSaving(true);
    try {
      const { settings: updated } = await adminApi.updateSettings(patch);
      setSettings(updated);
      toast.success('Settings saved.');
    } catch (err) {
      toast.error(err.displayMessage);
    } finally {
      setSaving(false);
    }
  };

  if (!form) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  /** One control, chosen by the registry's declared type. */
  const renderField = (setting) => {
    const { key, type, label, help, max, nullable } = setting;

    if (VISIBLE_WHEN[key] && !VISIBLE_WHEN[key](form)) return null;

    if (type === 'boolean') {
      return (
        <label key={key} className="mt-4 flex items-start gap-3">
          <input
            type="checkbox"
            checked={Boolean(form[key])}
            onChange={(e) => update(key, e.target.checked)}
            className="mt-0.5 rounded border-slate-300 dark:border-slate-700"
          />
          <span className="text-sm text-slate-700 dark:text-slate-300">
            {label}
            <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
              {help}
            </span>
          </span>
        </label>
      );
    }

    return (
      <div key={key} className="mt-4">
        <label
          htmlFor={`setting-${key}`}
          className="block text-sm font-medium text-slate-700 dark:text-slate-300"
        >
          {label}
        </label>

        {/* Long free text gets a textarea; everything else a single line.
            Messages are read as sentences, so a one-line input that
            scrolls sideways makes them hard to check before saving. */}
        {type === 'text' && max > 100 ? (
          <textarea
            id={`setting-${key}`}
            value={form[key]}
            onChange={(e) => update(key, e.target.value)}
            rows={2}
            maxLength={max}
            className={inputClass}
          />
        ) : (
          <input
            id={`setting-${key}`}
            type={type === 'number' ? 'number' : 'text'}
            value={form[key]}
            onChange={(e) => update(key, e.target.value)}
            {...(type === 'number' ? { min: 1, max } : { maxLength: max })}
            className={inputClass}
          />
        )}

        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {help}
          {type === 'domains' && ' Comma-separated.'}
          {nullable && ' Leave blank for the default.'}
        </p>
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold text-slate-900 dark:text-white">
        Portal settings
      </h1>

      {settings?.maintenanceMode && (
        <div
          role="status"
          className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          Maintenance mode is <strong>on</strong>. Students can read the portal but cannot
          submit or comment. Staff are unaffected.
        </div>
      )}

      {settings && settings.allowStudentSignups === false && (
        <div
          role="status"
          className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          Student registration is <strong>closed</strong>. New accounts cannot be created.
          Everyone who already has an account can still sign in as normal.
        </div>
      )}

      {settings && settings.allowAnonymousTickets === false && (
        <div
          role="status"
          className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          Anonymous submissions are <strong>off</strong>. New reports will carry the
          student&apos;s name. Reports already filed anonymously stay anonymous.
        </div>
      )}

      <form onSubmit={save} className="space-y-6">
        {manifest.map((group) => (
          <section
            key={group.id}
            className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
          >
            <h2 className="font-semibold text-slate-900 dark:text-white">{group.label}</h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {group.description}
            </p>

            {group.settings.map(renderField)}
          </section>
        ))}

        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-[#006633] px-5 py-2.5 font-medium text-white transition hover:bg-[#00552b] disabled:opacity-50"
        >
          {saving ? <Spinner size="sm" /> : 'Save settings'}
        </button>
      </form>
    </div>
  );
}
