/**
 * Profile settings.
 *
 * Email and role are read-only here: email changes go through Supabase's
 * verification flow, and role is assigned by an administrator.
 */

import { useState } from 'react';
import { Check, Mail, Shield } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Spinner } from '../components/Spinner.jsx';
import RoleBadge from '../components/RoleBadge.jsx';
import NotificationSettings from '../components/NotificationSettings.jsx';


const FIELDS = [
  { name: 'fullName', label: 'Full name', required: true },
  { name: 'matricNumber', label: 'Matriculation number' },
  { name: 'faculty', label: 'Faculty' },
  { name: 'department', label: 'Department' },
];

/*
 * SUPER_ADMIN and DEV were missing, so those accounts saw the raw enum
 * ("SUPER_ADMIN") on their own profile via the `?? profile?.role` fallback.
 */
const ROLE_LABELS = {
  STUDENT: 'Student',
  REP: 'SRC Representative',
  ADMIN: 'Administrator',
  SUPER_ADMIN: 'Super Administrator',
  DEV: 'Developer',
};


export default function Profile() {
  const { profile, user, updateProfile } = useAuth();
  const toast = useToast();

  const [form, setForm] = useState({
    fullName: profile?.fullName ?? '',
    matricNumber: profile?.matricNumber ?? '',
    faculty: profile?.faculty ?? '',
    department: profile?.department ?? '',
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const update = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }));
    setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFieldErrors({});
    setSaving(true);

    try {
      await updateProfile(form);
      toast.success('Profile updated.');
    } catch (err) {
      toast.error(err.message);
      setFieldErrors(err.fieldErrors ?? {});
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl py-4">
      <h1 className="mb-1 text-2xl font-semibold text-slate-900 dark:text-white">Your profile</h1>
      <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">
        Keeping this current helps the SRC route your reports correctly.
      </p>

      <div className="mb-4 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
        <p className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
          <Mail size={15} className="text-slate-400 dark:text-slate-500" />
          {user?.email}
          <span className="text-xs text-slate-400 dark:text-slate-500">(cannot be changed here)</span>
        </p>
        <p className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
          <Shield size={15} className="text-slate-400 dark:text-slate-500" />
          {ROLE_LABELS[profile?.role] ?? profile?.role}
          {/* The badge on the owner's own profile, so an admin can see the
              mark other users see beside their name. Nothing renders for a
              student, keeping the row unchanged for most accounts. */}
          <RoleBadge role={profile?.role} size={15} />
        </p>

      </div>

      <form
        onSubmit={handleSubmit}
        className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900"
        noValidate
      >
        {FIELDS.map(({ name, label, required }) => (
          <div key={name}>
            <label htmlFor={name} className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              {label}
              {required && <span className="text-red-500"> *</span>}
            </label>
            <input
              id={name}
              type="text"
              value={form[name]}
              onChange={update(name)}
              required={required}
              aria-invalid={Boolean(fieldErrors[name])}
              className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-1 ${
                fieldErrors[name]
                  ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                  : 'border-slate-300 focus:border-[#006633] focus:ring-[#006633]'
              }`}
            />
            {fieldErrors[name] && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{fieldErrors[name]}</p>
            )}
          </div>
        ))}

        <div className="flex justify-end border-t border-slate-100 pt-4 dark:border-slate-800">
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-2 rounded-lg bg-[#006633] px-5 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
          >
            {saving ? <Spinner size="sm" /> : <Check size={15} />}
            Save changes
          </button>
        </div>
      </form>

      {/* Outside the form — this toggle saves itself, and nesting it
          would make "Save changes" look responsible for it. */}
      <div className="mt-6">
        <NotificationSettings />
      </div>
    </div>
  );
}
