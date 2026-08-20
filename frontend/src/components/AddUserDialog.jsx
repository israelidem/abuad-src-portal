/**
 * Manual account creation, for when public registration is closed.
 *
 * Rendered only for a SUPER_ADMIN, but that is presentation only — the
 * server enforces the same rule and would refuse an ADMIN calling the
 * endpoint directly. The button is hidden because offering an action that
 * returns 403 is a poor experience, not because hiding it is a control.
 *
 * Accessibility is hand-written rather than pulled from a library, matching
 * ContactDeveloper.jsx: focus trap, Escape, restore focus on close. A modal
 * that strands a keyboard user is worse than no modal.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { adminApi } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { Spinner } from './Spinner.jsx';

/**
 * Mirrors the server's `createUserSchema` enum.
 *
 * SUPER_ADMIN is offered because only a super admin can open this dialog at
 * all — the endpoint refuses everyone else, so there is no lesser role here
 * that could use it to escalate.
 */
const ROLES = [
  { value: 'STUDENT', label: 'Student', hint: 'Can submit and track their own reports.' },
  { value: 'REP', label: 'Representative', hint: 'Handles reports for a department.' },
  { value: 'ADMIN', label: 'Admin', hint: 'Full moderation and user management.' },
  { value: 'SUPER_ADMIN', label: 'Super admin', hint: 'Also controls portal settings.' },
];

// 12, matching the server minimum. An account minted for someone else is
// handed over out-of-band, so it should not also be weak.
const MIN_PASSWORD = 12;

/** Crypto-random, and pre-filled: an admin inventing 12 characters on the spot reliably invents a weak one. */
const suggestPassword = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*';
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join('');
};

const BLANK = {
  fullName: '',
  email: '',
  password: '',
  role: 'STUDENT',
  matricNumber: '',
  faculty: '',
  department: '',
};

/**
 * Mounted only while open — the parent renders `{addOpen && <AddUserDialog…>}`.
 *
 * That is deliberate rather than incidental. An always-mounted dialog that
 * returns null has to clear its own fields on open, which means setting state
 * inside an effect and triggering a cascading render (ESLint flagged exactly
 * that in the first version of this file). Mounting fresh gives a blank form
 * for free and keeps the effect for what effects are for: DOM and listeners.
 */
export default function AddUserDialog({ onClose, onCreated }) {
  const toast = useToast();
  const titleId = useId();
  const descriptionId = useId();

  // Lazy initialiser, so the crypto call runs once per open and not on
  // every re-render as the admin types.
  const [form, setForm] = useState(() => ({ ...BLANK, password: suggestPassword() }));
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [revealPassword, setRevealPassword] = useState(false);

  const dialogRef = useRef(null);
  const firstFieldRef = useRef(null);
  // Captured on open so focus can go back where it came from. Reading
  // document.activeElement at close time would be too late — it is the
  // dialog by then.
  const triggerRef = useRef(null);

  useEffect(() => {
    triggerRef.current = document.activeElement;

    // Focus the first input, not the dialog: a screen reader announces the
    // labelled field, and a sighted admin can start typing immediately.
    firstFieldRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      // Without this wrap, Tab walks out of the dialog into the page behind,
      // where the focus ring is invisible and the user is lost.
      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]'
      );
      if (!focusable?.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Restore rather than hardcode 'visible' — the shell may have set its
      // own value that we would otherwise clobber.
      document.body.style.overflow = previousOverflow;
      // Guarded: the trigger may have unmounted underneath us, and calling
      // focus() on a detached node throws.
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
    };
  }, [onClose]);

  const set = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
    // Clear the server's complaint as soon as the field changes, so a
    // stale "already registered" does not sit under a corrected email.
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  /**
   * Client-side validation, deliberately a subset of the server's.
   *
   * This exists to save a round trip on obvious mistakes, not to be the
   * authority. The server re-validates everything.
   */
  const validate = () => {
    const errors = {};
    if (form.fullName.trim().length < 2) errors.fullName = 'Enter the full name.';
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) errors.email = 'Enter a valid email address.';
    if (form.password.length < MIN_PASSWORD) {
      errors.password = `Use at least ${MIN_PASSWORD} characters.`;
    }
    return errors;
  };

  const submit = async (event) => {
    event.preventDefault();

    const errors = validate();
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      // Move focus to the first problem, or a keyboard user has no idea
      // which field the error text belongs to.
      dialogRef.current?.querySelector(`[name="${Object.keys(errors)[0]}"]`)?.focus();
      return;
    }

    setSubmitting(true);
    try {
      // Optional fields are sent only when filled. Sending '' would store
      // an empty string where the column means "not provided".
      const { user } = await adminApi.createUser({
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
        ...(form.matricNumber.trim() ? { matricNumber: form.matricNumber.trim() } : {}),
        ...(form.faculty.trim() ? { faculty: form.faculty.trim() } : {}),
        ...(form.department.trim() ? { department: form.department.trim() } : {}),
      });

      toast.success(`${user.fullName} can now sign in as ${user.role.replace('_', ' ').toLowerCase()}.`);
      onCreated?.(user);
      onClose();
    } catch (err) {
      // The API attaches Zod field errors; show them next to the inputs
      // rather than as one long toast.
      const fields = err.fieldErrors ?? {};
      if (Object.keys(fields).length) {
        setFieldErrors(fields);
      } else if (err.status === 409) {
        // Duplicate email or matric number. The server does not say which
        // account holds it, so neither can we.
        const onMatric = /matric/i.test(err.message);
        setFieldErrors({ [onMatric ? 'matricNumber' : 'email']: err.message });
      } else {
        toast.error(err.displayMessage);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const fieldClass = (field) =>
    `w-full rounded-lg border px-3 py-2 text-sm text-slate-900 dark:bg-slate-900 dark:text-white ${
      fieldErrors[field]
        ? 'border-red-500 dark:border-red-500'
        : 'border-slate-300 dark:border-slate-700'
    }`;

  /** Error text tied to its input by id, so a screen reader reads them together. */
  const errorFor = (field) =>
    fieldErrors[field] ? (
      <p id={`${titleId}-${field}-error`} className="mt-1 text-xs text-red-600 dark:text-red-400">
        {fieldErrors[field]}
      </p>
    ) : null;

  const aria = (field) => ({
    'aria-invalid': fieldErrors[field] ? true : undefined,
    'aria-describedby': fieldErrors[field] ? `${titleId}-${field}-error` : undefined,
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      // Backdrop click closes. The dialog below stops propagation, so a
      // click inside it does not count as a backdrop click.
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(event) => event.stopPropagation()}
        // Bottom sheet on phones, centred card above sm — the top of a tall
        // phone screen is awkward to reach one-handed. max-h + scroll so the
        // form is still usable on a short landscape viewport.
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl dark:bg-slate-900 sm:rounded-2xl sm:p-6"
      >
        <div className="mb-1 flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-bold text-slate-900 dark:text-white">
            Add new user
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p id={descriptionId} className="mb-4 text-sm text-slate-600 dark:text-slate-400">
          Creates an account directly. This works even when public registration
          is closed. Share the password with them over a channel you trust.
        </p>

        <form onSubmit={submit} noValidate className="space-y-4">
          <div>
            <label htmlFor={`${titleId}-fullName`} className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Full name
            </label>
            <input
              ref={firstFieldRef}
              id={`${titleId}-fullName`}
              name="fullName"
              value={form.fullName}
              onChange={set('fullName')}
              autoComplete="off"
              className={fieldClass('fullName')}
              {...aria('fullName')}
            />
            {errorFor('fullName')}
          </div>

          <div>
            <label htmlFor={`${titleId}-email`} className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Email
            </label>
            <input
              id={`${titleId}-email`}
              name="email"
              type="email"
              value={form.email}
              onChange={set('email')}
              autoComplete="off"
              className={fieldClass('email')}
              {...aria('email')}
            />
            {errorFor('email')}
          </div>

          <div>
            <label htmlFor={`${titleId}-password`} className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Temporary password
            </label>
            <div className="flex gap-2">
              <input
                id={`${titleId}-password`}
                name="password"
                // Visible by default is the right default *here*: the admin
                // must read this out to hand it over, and it is not their own
                // credential. Toggle for shoulder-surfing.
                type={revealPassword ? 'text' : 'password'}
                value={form.password}
                onChange={set('password')}
                autoComplete="new-password"
                className={`${fieldClass('password')} font-mono`}
                {...aria('password')}
              />
              <button
                type="button"
                onClick={() => setRevealPassword((v) => !v)}
                aria-pressed={revealPassword}
                className="min-h-11 shrink-0 rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {revealPassword ? 'Hide' : 'Show'}
              </button>
              <button
                type="button"
                onClick={() => setForm((c) => ({ ...c, password: suggestPassword() }))}
                className="min-h-11 shrink-0 rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Regenerate
              </button>
            </div>
            {errorFor('password') ?? (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Pre-filled with a random {MIN_PASSWORD}+ character password.
              </p>
            )}
          </div>

          <fieldset>
            <legend className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Role
            </legend>
            <select
              name="role"
              value={form.role}
              onChange={set('role')}
              aria-label="Role"
              className={fieldClass('role')}
            >
              {ROLES.map((role) => (
                <option key={role.value} value={role.value}>
                  {role.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {ROLES.find((r) => r.value === form.role)?.hint}
            </p>
          </fieldset>

          {/* Optional, and grouped so the required fields above read as the
              short path. A staff account has no matric number. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${titleId}-matricNumber`} className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                Matric number <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                id={`${titleId}-matricNumber`}
                name="matricNumber"
                value={form.matricNumber}
                onChange={set('matricNumber')}
                autoComplete="off"
                className={fieldClass('matricNumber')}
                {...aria('matricNumber')}
              />
              {errorFor('matricNumber')}
            </div>

            <div>
              <label htmlFor={`${titleId}-faculty`} className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                Faculty <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                id={`${titleId}-faculty`}
                name="faculty"
                value={form.faculty}
                onChange={set('faculty')}
                autoComplete="off"
                className={fieldClass('faculty')}
              />
            </div>
          </div>

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-slate-800 px-4 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-60 dark:bg-slate-700"
            >
              {submitting && <Spinner size="sm" />}
              {submitting ? 'Creating…' : 'Create account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
