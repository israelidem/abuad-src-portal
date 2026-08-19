/**
 * Report an issue.
 *
 * Attachments upload to Storage first, then the ticket is created with
 * their paths. If creation fails the uploads are cleaned up, so a failed
 * submission doesn't leave files behind.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, MapPin } from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { ticketApi, departmentApi } from '../lib/api.js';
import { uploadAttachment, removeAttachment } from '../lib/uploads.js';
import { CATEGORIES, URGENCIES } from '../lib/constants.js';
import AttachmentPicker from '../components/AttachmentPicker.jsx';
import { Spinner } from '../components/Spinner.jsx';

const MIN_DESCRIPTION = 20;

/**
 * Privacy presets.
 *
 * The API still stores two independent booleans; this collapses them into
 * one decision the reporter can actually reason about. Keeping the mapping
 * in one table means the form never has to derive it inline.
 */
const PRIVACY_OPTIONS = [
  {
    value: 'PUBLIC_NAMED',
    label: 'Public board, with my name',
    hint: 'Other students can see and upvote it, and can see it came from you.',
    isPublic: true,
    isAnonymous: false,
  },
  {
    value: 'PUBLIC_ANONYMOUS',
    label: 'Public board, anonymously',
    hint: 'Others can see and upvote it, but your name is hidden — including from SRC staff. Administrators can still trace serious abuse.',
    isPublic: true,
    isAnonymous: true,
  },
  {
    value: 'PRIVATE',
    label: 'SRC staff only',
    hint: "Kept off the public board. Staff will see your name so they can follow up, but other students won't see the report at all.",
    isPublic: false,
    isAnonymous: false,
  },
];

const DEFAULT_PRIVACY = 'PUBLIC_NAMED';

export default function NewTicket() {
  const { profile, user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [departments, setDepartments] = useState([]);
  const [files, setFiles] = useState([]);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [stage, setStage] = useState('');

  const [form, setForm] = useState({
    faculty: profile?.faculty ?? '',
    description: '',
    urgency: 'MEDIUM',
    locationText: '',
    departmentId: '',
    privacy: DEFAULT_PRIVACY,
  });

  useEffect(() => {
    departmentApi
      .list()
      .then((data) => setDepartments(data.departments))
      // The picker is required now, so a failed fetch leaves the form
      // unsubmittable. Say so rather than showing an empty dropdown the
      // student can't get past.
      .catch(() =>
        setError('Could not load the list of departments. Please refresh and try again.')
      );
  }, []);

  // The category is no longer asked for — it follows from the department,
  // and this is what lets the form show which one it will be.
  const selectedDepartment = departments.find((d) => d.id === form.departmentId) ?? null;

  const update = (field) => (event) => {
    const value =
      event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setFieldErrors({});

    if (!form.departmentId) {
      return setFieldErrors({ departmentId: 'Please choose what this is about.' });
    }

    if (form.description.trim().length < MIN_DESCRIPTION) {
      return setFieldErrors({
        description: `Please write at least ${MIN_DESCRIPTION} characters so the SRC can act on it.`,
      });
    }

    setSubmitting(true);
    const uploaded = [];

    // Expand the single privacy choice back into the two flags the API
    // stores. Derived here, before the uploads, because the upload path
    // depends on the anonymity flag — deriving it after the loop would
    // read it before initialisation.
    const { privacy, ...fields } = form;
    const preset = PRIVACY_OPTIONS.find((o) => o.value === privacy) ?? PRIVACY_OPTIONS[0];

    try {
      if (files.length) {
        setStage(`Uploading ${files.length} photo${files.length > 1 ? 's' : ''}…`);
        for (const file of files) {
          // The anonymity flag must follow the file, not just the ticket:
          // a public bucket plus a userId-prefixed path would publish the
          // author of an anonymous submission in the image URL.
          uploaded.push(
            await uploadAttachment(file, user.id, { anonymous: preset.isAnonymous })
          );
        }
      }

      setStage('Submitting your report…');

      const { ticket } = await ticketApi.create({
        ...fields,
        // No `category` — the API derives it from the department.
        locationText: form.locationText || undefined,
        isPublic: preset.isPublic,
        isAnonymous: preset.isAnonymous,
        attachments: uploaded,
      });

      toast.success(`Reported as ${ticket.ticketNumber}.`);
      navigate(`/tickets/${ticket.id}`, { replace: true });
    } catch (err) {
      // Don't strand the uploads if the ticket never got created
      await Promise.all(uploaded.map((a) => removeAttachment(a.storagePath)));

      setError(err.displayMessage ?? err.message);
      setFieldErrors(err.fieldErrors ?? {});
    } finally {
      setSubmitting(false);
      setStage('');
    }
  };

  const inputClass = (field) =>
    `w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-1 ${
      fieldErrors[field]
        ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
        : 'border-slate-300 focus:border-[#006633] focus:ring-[#006633]'
    }`;

  const remaining = MIN_DESCRIPTION - form.description.trim().length;

  return (
    <div className="mx-auto max-w-2xl py-4">
      <h1 className="mb-1 text-2xl font-semibold text-slate-900 dark:text-white">Report an issue</h1>
      <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">
        The more detail you give, the faster the SRC can act.
      </p>

      {error && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
        >
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900"
        noValidate
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="departmentId" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              What is this about? <span className="text-red-500">*</span>
            </label>
            <select
              id="departmentId"
              value={form.departmentId}
              onChange={update('departmentId')}
              required
              className={inputClass('departmentId')}
            >
              <option value="">Choose the desk that handles this</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            {fieldErrors.departmentId ? (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {fieldErrors.departmentId}
              </p>
            ) : (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                This decides who picks it up. The SRC can re-route it if it lands wrong.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="urgency" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Urgency <span className="text-red-500">*</span>
            </label>
            <select
              id="urgency"
              value={form.urgency}
              onChange={update('urgency')}
              required
              className={inputClass('urgency')}
            >
              {Object.entries(URGENCIES).map(([value, { label }]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              High is resolved within 24 hours, medium 3 days, low a week.
            </p>
          </div>

          <div>
            <label htmlFor="faculty" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Faculty <span className="text-red-500">*</span>
            </label>
            <input
              id="faculty"
              type="text"
              value={form.faculty}
              onChange={update('faculty')}
              required
              placeholder="e.g. Engineering"
              className={inputClass('faculty')}
            />
            {fieldErrors.faculty && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{fieldErrors.faculty}</p>
            )}
          </div>

          <div>
            <label htmlFor="urgencyNote" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Category
            </label>
            {/* Read-only: the category now follows from the department, so
                showing it as a second dropdown just asked the same
                question twice. Kept visible because students recognise
                their report by it on the board. */}
            <p
              id="urgencyNote"
              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
            >
              {selectedDepartment
                ? CATEGORIES[selectedDepartment.category]?.label ?? 'Other'
                : 'Set automatically from your choice above'}
            </p>
          </div>
        </div>

        <div>
          <label htmlFor="locationText" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
            Location <span className="font-normal text-slate-400 dark:text-slate-500">(optional)</span>
          </label>
          <div className="relative">
            <MapPin
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
              aria-hidden="true"
            />
            <input
              id="locationText"
              type="text"
              value={form.locationText}
              onChange={update('locationText')}
              placeholder="e.g. Block C, second floor"
              className={`${inputClass('locationText')} pl-9`}
            />
          </div>
        </div>

        <div>
          <label htmlFor="description" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
            What&apos;s the problem? <span className="text-red-500">*</span>
          </label>
          <textarea
            id="description"
            value={form.description}
            onChange={update('description')}
            required
            rows={6}
            placeholder="Describe what's wrong, when it started, and who it affects."
            aria-describedby="description-help"
            className={inputClass('description')}
          />
          <p
            id="description-help"
            className={`mt-1 text-xs ${remaining > 0 ? 'text-slate-500' : 'text-green-600'}`}
          >
            {remaining > 0
              ? `${remaining} more character${remaining === 1 ? '' : 's'} needed`
              : `${form.description.trim().length} characters`}
          </p>
          {fieldErrors.description && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">{fieldErrors.description}</p>
          )}
        </div>

        <AttachmentPicker files={files} onChange={setFiles} disabled={submitting} />

        {/*
          One choice instead of two checkboxes.

          Two independent boxes produced four states, and the two that
          mattered ("public but unnamed", "named but private") were the
          least obvious to reach. A single list makes the visibility and
          the naming consequence of each option explicit.
        */}
        <fieldset className="space-y-2 rounded-lg bg-slate-50 p-4 dark:bg-slate-900">
          <legend className="px-1 text-sm font-medium text-slate-700 dark:text-slate-300">
            Who can see this report?
          </legend>

          {PRIVACY_OPTIONS.map((option) => {
            const selected = form.privacy === option.value;
            return (
              <label
                key={option.value}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                  selected
                    ? 'border-[#006633] bg-[#006633]/[0.06]'
                    : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                <input
                  type="radio"
                  name="privacy"
                  value={option.value}
                  checked={selected}
                  onChange={() => setForm((prev) => ({ ...prev, privacy: option.value }))}
                  className="mt-0.5 h-4 w-4 border-slate-300 text-[#006633] focus:ring-[#006633] dark:border-slate-700"
                />
                <span className="text-sm">
                  <span className="font-medium text-slate-800 dark:text-slate-100">{option.label}</span>
                  <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{option.hint}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        <div className="flex items-center justify-end gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
          <button
            type="button"
            onClick={() => navigate(-1)}
            disabled={submitting}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50 dark:border-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="flex items-center gap-2 rounded-lg bg-[#006633] px-5 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
          >
            {submitting && <Spinner size="sm" />}
            {stage || 'Submit report'}
          </button>
        </div>
      </form>
    </div>
  );
}
