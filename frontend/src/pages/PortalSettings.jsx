/**
 * Portal settings — super admin only.
 *
 * Two things live here that can lock people out: signup domain rules and
 * maintenance mode. Both are shown with their consequences spelled out,
 * because "restrict domains" with an empty list would otherwise reject
 * every new signup with no obvious cause.
 */

import { useEffect, useState } from 'react';

import { adminApi } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { Spinner } from '../components/Spinner.jsx';

/** "a.com, b.com" <-> ['a.com','b.com'] — blanks dropped, lowercased. */
const parseList = (text) =>
  text
    .split(/[,\n]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

export default function PortalSettings() {
  const toast = useToast();

  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    adminApi
      .settings({ signal: controller.signal })
      .then(({ settings: loaded }) => {
        setSettings(loaded);
        setForm({
          restrictSignupDomains: loaded.restrictSignupDomains,
          allowedDomains: loaded.allowedDomains.join(', '),
          allowSubdomains: loaded.allowSubdomains,
          blockedDomains: loaded.blockedDomains.join(', '),
          maintenanceMode: loaded.maintenanceMode,
          maintenanceMessage: loaded.maintenanceMessage ?? '',
        });
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

    const allowed = parseList(form.allowedDomains);

    // The API rejects this too, but catching it here explains *why*
    // instead of surfacing a generic validation error.
    if (form.restrictSignupDomains && allowed.length === 0) {
      toast.error('Add at least one allowed domain, or turn the restriction off.');
      return;
    }

    setSaving(true);
    try {
      const { settings: updated } = await adminApi.updateSettings({
        restrictSignupDomains: form.restrictSignupDomains,
        allowedDomains: allowed,
        allowSubdomains: form.allowSubdomains,
        blockedDomains: parseList(form.blockedDomains),
        maintenanceMode: form.maintenanceMode,
        maintenanceMessage: form.maintenanceMessage.trim() || null,
      });
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

      <form onSubmit={save} className="space-y-6">
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-semibold text-slate-900 dark:text-white">Who can sign up</h2>

          <label className="mt-4 flex items-start gap-3">
            <input
              type="checkbox"
              checked={form.restrictSignupDomains}
              onChange={(e) => update('restrictSignupDomains', e.target.checked)}
              className="mt-0.5 rounded border-slate-300 dark:border-slate-700"
            />
            <span className="text-sm text-slate-700 dark:text-slate-300">
              Restrict signup to specific email domains
              <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                Off means any email address can register.
              </span>
            </span>
          </label>

          {form.restrictSignupDomains && (
            <div className="mt-4 space-y-4 border-l-2 border-slate-100 pl-4 dark:border-slate-800">
              <div>
                <label
                  htmlFor="allowed"
                  className="block text-sm font-medium text-slate-700 dark:text-slate-300"
                >
                  Allowed domains
                </label>
                <input
                  id="allowed"
                  value={form.allowedDomains}
                  onChange={(e) => update('allowedDomains', e.target.value)}
                  placeholder="abuad.edu.ng, student.abuad.edu.ng"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-white"
                />
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Comma-separated.
                </p>
              </div>

              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={form.allowSubdomains}
                  onChange={(e) => update('allowSubdomains', e.target.checked)}
                  className="mt-0.5 rounded border-slate-300 dark:border-slate-700"
                />
                <span className="text-sm text-slate-700 dark:text-slate-300">
                  Allow subdomains
                  <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                    With this on, allowing <code>abuad.edu.ng</code> also accepts{' '}
                    <code>eng.abuad.edu.ng</code>.
                  </span>
                </span>
              </label>
            </div>
          )}

          <div className="mt-4">
            <label
              htmlFor="blocked"
              className="block text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              Blocked domains
            </label>
            <input
              id="blocked"
              value={form.blockedDomains}
              onChange={(e) => update('blockedDomains', e.target.value)}
              placeholder="tempmail.com, guerrillamail.com"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-white"
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Always rejected, even when they match an allowed domain.
            </p>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-semibold text-slate-900 dark:text-white">Maintenance mode</h2>

          <label className="mt-4 flex items-start gap-3">
            <input
              type="checkbox"
              checked={form.maintenanceMode}
              onChange={(e) => update('maintenanceMode', e.target.checked)}
              className="mt-0.5 rounded border-slate-300 dark:border-slate-700"
            />
            <span className="text-sm text-slate-700 dark:text-slate-300">
              Pause new submissions and comments
              <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                Reading stays available for everyone. Staff can still act on tickets, so
                work in progress isn't blocked.
              </span>
            </span>
          </label>

          <div className="mt-4">
            <label
              htmlFor="maintenance-message"
              className="block text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              Message shown to students
            </label>
            <textarea
              id="maintenance-message"
              value={form.maintenanceMessage}
              onChange={(e) => update('maintenanceMessage', e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="We're carrying out scheduled maintenance. Please try again after 6pm."
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-white"
            />
          </div>
        </section>

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
