/**
 * Department management.
 *
 * Departments are the routing backbone: every ticket must pick one, and
 * the choice sets the ticket's category. The API has supported full CRUD
 * (admin-only) since the beginning, but there was no screen for it — so
 * standing up a new desk, renaming one, or retiring one required direct
 * database access. That is the gap this closes.
 *
 * Two behaviours worth knowing, both enforced server-side:
 *
 *   - Removal is not always a delete. If any ticket references the
 *     department, the API deactivates it instead so the historical record
 *     survives. The UI reports which actually happened rather than
 *     claiming "deleted" either way.
 *   - Inactive departments stay listed here but disappear from the
 *     student submission form.
 */

import { useCallback, useEffect, useState } from 'react';
import { Building2, Plus, Power, Trash2, X, AlertCircle } from 'lucide-react';

import { departmentApi } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { CATEGORIES } from '../lib/constants.js';
import { Skeleton } from '../components/Spinner.jsx';

/** Mirrors the API's slug rule so the error appears before the round trip. */
const slugify = (value) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

const EMPTY_FORM = { name: '', slug: '', description: '', category: 'OTHER' };

function DepartmentSkeleton() {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-2 flex items-center gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-5 w-16" />
      </div>
      <Skeleton className="mb-2 h-4 w-full" />
      <Skeleton className="h-4 w-1/3" />
    </div>
  );
}

export default function DepartmentManagement() {
  const toast = useToast();

  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState({});

  const load = useCallback(
    async (signal) => {
      try {
        // listAll, not list: an admin needs to see the retired desks in
        // order to bring one back.
        const data = await departmentApi.listAll({ signal });
        setDepartments(data.departments);
      } catch (err) {
        if (err.name !== 'AbortError') toast.error(err.displayMessage);
      } finally {
        setLoading(false);
      }
    },
    [toast]
  );

  useEffect(() => {
    const controller = new AbortController();
    // Fetch-on-mount, matching the other admin pages. The rule guards
    // against cascading renders, but the list has to come from the server
    // before anything can be shown, and the request aborts on unmount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const handleCreate = async (event) => {
    event.preventDefault();
    setFieldErrors({});

    // Derive the slug if the admin didn't type one. Asking for both a
    // name and a URL-safe key is a detail they shouldn't have to think
    // about for the common case.
    const payload = {
      ...form,
      slug: form.slug.trim() || slugify(form.name),
      description: form.description.trim() || undefined,
    };

    if (!payload.slug) {
      return setFieldErrors({ name: 'Please enter a name.' });
    }

    setCreating(true);
    try {
      const { department } = await departmentApi.create(payload);
      setDepartments((prev) =>
        [...prev, { ...department, ticketCount: 0 }].sort((a, b) =>
          a.name.localeCompare(b.name)
        )
      );
      setForm(EMPTY_FORM);
      toast.success(`${department.name} added.`);
    } catch (err) {
      setFieldErrors(err.fieldErrors ?? {});
      toast.error(err.displayMessage);
    } finally {
      setCreating(false);
    }
  };

  const toggleActive = async (dept) => {
    setBusyId(dept.id);
    try {
      const { department } = await departmentApi.update(dept.id, {
        isActive: !dept.isActive,
      });
      setDepartments((prev) =>
        prev.map((d) => (d.id === dept.id ? { ...d, isActive: department.isActive } : d))
      );
      toast.success(
        department.isActive
          ? `${dept.name} is accepting reports again.`
          : `${dept.name} is hidden from the report form.`
      );
    } catch (err) {
      toast.error(err.displayMessage);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (dept) => {
    // Spell out the consequence, which differs depending on usage.
    const warning =
      dept.ticketCount > 0
        ? `${dept.name} has ${dept.ticketCount} report(s), so it will be deactivated rather than deleted. Continue?`
        : `Delete ${dept.name}? This cannot be undone.`;

    if (!window.confirm(warning)) return;

    setBusyId(dept.id);
    try {
      const result = await departmentApi.remove(dept.id);

      if (result.deactivated) {
        // Still present, just retired — reflect that instead of removing
        // the row, which would wrongly imply the data is gone.
        setDepartments((prev) =>
          prev.map((d) => (d.id === dept.id ? { ...d, isActive: false } : d))
        );
      } else {
        setDepartments((prev) => prev.filter((d) => d.id !== dept.id));
      }

      toast.success(result.message);
    } catch (err) {
      toast.error(err.displayMessage);
    } finally {
      setBusyId(null);
    }
  };

  const inputClass = (field) =>
    `w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-1 dark:bg-slate-950 dark:text-white ${
      fieldErrors[field]
        ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
        : 'border-slate-300 focus:border-[#006633] focus:ring-[#006633] dark:border-slate-700'
    }`;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900 dark:text-white">
          <Building2 size={22} className="text-[#006633]" />
          Departments
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          These are the desks students choose from when reporting an issue. The department
          also decides the report&apos;s category.
        </p>
      </div>

      <form
        onSubmit={handleCreate}
        className="mb-8 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
      >
        <h2 className="mb-4 flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
          <Plus size={17} className="text-[#006633]" />
          Add a department
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="dept-name"
              className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              Name <span className="text-red-500">*</span>
            </label>
            <input
              id="dept-name"
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              required
              placeholder="e.g. Hostel & Accommodation"
              className={inputClass('name')}
            />
            {fieldErrors.name && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{fieldErrors.name}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="dept-category"
              className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              Category <span className="text-red-500">*</span>
            </label>
            <select
              id="dept-category"
              value={form.category}
              onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))}
              className={inputClass('category')}
            >
              {Object.entries(CATEGORIES).map(([value, { label }]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Applied to every report sent here.
            </p>
          </div>

          <div className="sm:col-span-2">
            <label
              htmlFor="dept-description"
              className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              Description{' '}
              <span className="font-normal text-slate-400 dark:text-slate-500">(optional)</span>
            </label>
            <input
              id="dept-description"
              type="text"
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              placeholder="What this desk handles"
              className={inputClass('description')}
            />
            {fieldErrors.slug && (
              <p className="mt-1 flex items-start gap-1 text-xs text-red-600 dark:text-red-400">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                {fieldErrors.slug}
              </p>
            )}
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            disabled={creating || !form.name.trim()}
            className="rounded-lg bg-[#006633] px-5 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
          >
            {creating ? 'Adding…' : 'Add department'}
          </button>
        </div>
      </form>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Current departments {!loading && `(${departments.length})`}
      </h2>

      {loading ? (
        <div className="space-y-3" role="status" aria-label="Loading departments">
          {Array.from({ length: 4 }, (_, i) => (
            <DepartmentSkeleton key={i} />
          ))}
        </div>
      ) : departments.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          No departments yet. Add one above so students have somewhere to send reports.
        </p>
      ) : (
        <ul className="space-y-3">
          {departments.map((dept) => (
            <li
              key={dept.id}
              className={`rounded-xl border p-4 ${
                dept.isActive
                  ? 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
                  : // Retired desks are dimmed rather than hidden: an admin
                    // needs to find one to reactivate it.
                    'border-slate-200 bg-slate-50 opacity-75 dark:border-slate-800 dark:bg-slate-950'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-slate-900 dark:text-white">
                      {dept.name}
                    </h3>

                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {CATEGORIES[dept.category]?.label ?? dept.category}
                    </span>

                    {!dept.isActive && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        Hidden from students
                      </span>
                    )}
                  </div>

                  {dept.description && (
                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                      {dept.description}
                    </p>
                  )}

                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-500">
                    {dept.ticketCount} report{dept.ticketCount === 1 ? '' : 's'} ·{' '}
                    <code className="font-mono">{dept.slug}</code>
                  </p>
                </div>

                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => toggleActive(dept)}
                    disabled={busyId === dept.id}
                    className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    <Power size={13} />
                    {dept.isActive ? 'Hide' : 'Restore'}
                  </button>

                  <button
                    type="button"
                    onClick={() => remove(dept)}
                    disabled={busyId === dept.id}
                    aria-label={`Remove ${dept.name}`}
                    className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/40"
                  >
                    {dept.ticketCount > 0 ? <X size={13} /> : <Trash2 size={13} />}
                    Remove
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
