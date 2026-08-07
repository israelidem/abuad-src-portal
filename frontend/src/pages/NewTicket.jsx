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
    category: '',
    description: '',
    urgency: 'MEDIUM',
    locationText: '',
    departmentId: '',
    isAnonymous: false,
    isPublic: true,
  });

  useEffect(() => {
    departmentApi
      .list()
      .then((data) => setDepartments(data.departments))
      .catch(() => setDepartments([])); // the field is optional
  }, []);

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

    if (form.description.trim().length < MIN_DESCRIPTION) {
      return setFieldErrors({
        description: `Please write at least ${MIN_DESCRIPTION} characters so the SRC can act on it.`,
      });
    }

    setSubmitting(true);
    const uploaded = [];

    try {
      if (files.length) {
        setStage(`Uploading ${files.length} photo${files.length > 1 ? 's' : ''}…`);
        for (const file of files) {
          uploaded.push(await uploadAttachment(file, user.id));
        }
      }

      setStage('Submitting your report…');
      const { ticket } = await ticketApi.create({
        ...form,
        departmentId: form.departmentId || undefined,
        locationText: form.locationText || undefined,
        attachments: uploaded,
      });

      toast.success(`Reported as ${ticket.ticketNumber}.`);
      navigate(`/tickets/${ticket.id}`, { replace: true });
    } catch (err) {
      // Don't strand the uploads if the ticket never got created
      await Promise.all(uploaded.map((a) => removeAttachment(a.storagePath)));

      setError(err.message);
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
      <h1 className="mb-1 text-2xl font-semibold text-slate-900">Report an issue</h1>
      <p className="mb-6 text-sm text-slate-600">
        The more detail you give, the faster the SRC can act.
      </p>

      {error && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        noValidate
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="category" className="mb-1 block text-sm font-medium text-slate-700">
              Category <span className="text-red-500">*</span>
            </label>
            <select
              id="category"
              value={form.category}
              onChange={update('category')}
              required
              className={inputClass('category')}
            >
              <option value="">Choose a category</option>
              {Object.entries(CATEGORIES).map(([value, { label }]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {fieldErrors.category && (
              <p className="mt-1 text-xs text-red-600">{fieldErrors.category}</p>
            )}
          </div>

          <div>
            <label htmlFor="urgency" className="mb-1 block text-sm font-medium text-slate-700">
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
            <p className="mt-1 text-xs text-slate-500">
              High is resolved within 24 hours, medium 3 days, low a week.
            </p>
          </div>

          <div>
            <label htmlFor="faculty" className="mb-1 block text-sm font-medium text-slate-700">
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
              <p className="mt-1 text-xs text-red-600">{fieldErrors.faculty}</p>
            )}
          </div>

          <div>
            <label htmlFor="departmentId" className="mb-1 block text-sm font-medium text-slate-700">
              Route to <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <select
              id="departmentId"
              value={form.departmentId}
              onChange={update('departmentId')}
              className={inputClass('departmentId')}
            >
              <option value="">Let the SRC decide</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="locationText" className="mb-1 block text-sm font-medium text-slate-700">
            Location <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <div className="relative">
            <MapPin
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
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
          <label htmlFor="description" className="mb-1 block text-sm font-medium text-slate-700">
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
            <p className="mt-1 text-xs text-red-600">{fieldErrors.description}</p>
          )}
        </div>

        <AttachmentPicker files={files} onChange={setFiles} disabled={submitting} />

        <fieldset className="space-y-3 rounded-lg bg-slate-50 p-4">
          <legend className="px-1 text-sm font-medium text-slate-700">Privacy</legend>

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={form.isAnonymous}
              onChange={update('isAnonymous')}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-[#006633] focus:ring-[#006633]"
            />
            <span className="text-sm">
              <span className="font-medium text-slate-800">Report anonymously</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                Your name won&apos;t be shown to anyone, including SRC staff. Administrators can
                still trace serious abuse.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={form.isPublic}
              onChange={update('isPublic')}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-[#006633] focus:ring-[#006633]"
            />
            <span className="text-sm">
              <span className="font-medium text-slate-800">Show on the public board</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                Other students can upvote it, which helps the SRC prioritise.
              </span>
            </span>
          </label>
        </fieldset>

        <div className="flex items-center justify-end gap-3 border-t border-slate-100 pt-4">
          <button
            type="button"
            onClick={() => navigate(-1)}
            disabled={submitting}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50"
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
