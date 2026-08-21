/**
 * Create account.
 *
 * Note there's no role selector. The old form let you pick "admin" at
 * signup; role is now assigned server-side and defaults to STUDENT.
 *
 * The email is checked against the domain policy on blur, so a student
 * using a personal address finds out before filling in the whole form.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, AlertCircle, CheckCircle, Info, Lock } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { authApi, adminApi } from '../lib/api.js';
import { Spinner } from '../components/Spinner.jsx';
import Logo from '../components/Logo.jsx';

/*
 * Every field here is now required (requirement 6). The three identity
 * fields were optional and labelled "Optional", so most registrations
 * arrived without them and tickets could not be attributed to a faculty
 * or department — the dimension the whole board is filtered by.
 *
 * `required` drives the asterisk, the `required` attribute and the
 * pre-submit check below from one place, so the three cannot disagree.
 * signupSchema on the server enforces the same rule; this only saves a
 * round trip.
 */
const FIELDS = [
  { name: 'fullName', label: 'Full name', type: 'text', required: true, autoComplete: 'name' },
  {
    name: 'matricNumber',
    label: 'Matriculation number',
    type: 'text',
    required: true,
    placeholder: 'e.g. 20/ENG01/001',
    // A concrete example rather than "Optional": the format is not
    // obvious, and the value is normalised (upper-cased, spaces removed)
    // on the server, so the student cannot get the casing wrong.
    autoComplete: 'off',
  },
  { name: 'faculty', label: 'Faculty', type: 'text', required: true, placeholder: 'e.g. Engineering' },
  { name: 'department', label: 'Department', type: 'text', required: true, placeholder: 'e.g. Computer Engineering' },
];

/** Message shown when a required field is submitted empty. */
const REQUIRED_MESSAGES = {
  fullName: 'Please enter your full name.',
  matricNumber: 'Please enter your matric number.',
  faculty: 'Please enter your faculty.',
  department: 'Please enter your department.',
};


export default function Signup() {
  const { signUp } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    fullName: '',
    email: '',
    password: '',
    matricNumber: '',
    faculty: '',
    department: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [emailHint, setEmailHint] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null);

  /**
   * Whether registration is open.
   *
   * `null` = not yet known, so the form isn't flashed before we find out.
   * This is presentation only — the real gate is in POST /api/auth/signup,
   * which rejects a closed signup regardless of what this says. If the
   * check fails we assume open and let the API deliver the bad news,
   * rather than blocking a legitimate student over a failed request.
   */
  const [signupOpen, setSignupOpen] = useState(null);
  const [closedMessage, setClosedMessage] = useState('');

  useEffect(() => {
    const controller = new AbortController();

    adminApi
      .maintenance({ signal: controller.signal })
      .then(({ allowStudentSignups, signupClosedMessage }) => {
        setSignupOpen(allowStudentSignups ?? true);
        setClosedMessage(signupClosedMessage ?? '');
      })
      .catch(() => setSignupOpen(true));

    return () => controller.abort();
  }, []);

  const update = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }));
    // Clear the error as soon as the user starts correcting it
    setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  };

  /** Warns about a disallowed domain before the form is submitted. */
  const handleEmailBlur = async () => {
    if (!form.email.includes('@')) return setEmailHint(null);
    try {
      const result = await authApi.checkEmail(form.email);
      setEmailHint(result);
    } catch {
      setEmailHint(null); // a failed check shouldn't block the form
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setFieldErrors({});

    /*
     * Client-side required check.
     *
     * The form carries `noValidate`, so the browser's own bubbles never
     * appear and the `required` attributes alone would let an empty
     * submission through to the API. Checking here keeps the errors in the
     * page's own style, next to the offending field, and shows all of them
     * at once instead of one per round trip.
     *
     * Trimmed, so "   " is not accepted — matching the server, which
     * trims before its own min(1).
     *
     * This is a convenience, not the gate: signupSchema rejects the same
     * request if it arrives anyway.
     */
    const missing = {};
    for (const { name, required } of FIELDS) {
      if (required && !form[name].trim()) missing[name] = REQUIRED_MESSAGES[name];
    }

    if (Object.keys(missing).length) {
      setFieldErrors(missing);
      setError('Please complete all required fields.');
      // Focus the first offender: on a phone the error can easily be off
      // screen, and a form that "does nothing" on tap is the result.
      document.getElementById(Object.keys(missing)[0])?.focus();
      return;
    }

    setSubmitting(true);

    try {

      const result = await signUp(form);

      if (result.session) {
        navigate('/dashboard', { replace: true });
      } else {
        // Email confirmation is on — tell them to check their inbox
        setDone(result.message ?? 'Check your email to confirm your account.');
      }
    } catch (err) {
      setError(err.message);
      setFieldErrors(err.fieldErrors ?? {});
    } finally {
      setSubmitting(false);
    }
  };

  if (signupOpen === null) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!signupOpen) {
    return (
      <div className="mx-auto max-w-md py-8">
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <Logo size="lg" onLight className="mx-auto mb-4" />
          <Lock size={32} className="mx-auto mb-4 text-amber-600 dark:text-amber-400" />
          <h1 className="mb-2 text-xl font-semibold text-slate-900 dark:text-white">
            Registration currently closed
          </h1>
          <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">
            {closedMessage ||
              'New student registrations are temporarily unavailable. Please check back later or contact the SRC.'}
          </p>
          <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">
            Already have an account? You can still sign in.
          </p>
          <Link
            to="/login"
            className="inline-block rounded-lg bg-[#006633] px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mx-auto max-w-md py-8">
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <CheckCircle size={40} className="mx-auto mb-4 text-green-600 dark:text-green-400" />
          <h1 className="mb-2 text-xl font-semibold text-slate-900 dark:text-white">Almost there</h1>
          <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">{done}</p>
          <Link
            to="/login"
            className="inline-block rounded-lg bg-[#006633] px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  const inputClass = (field) =>
    `w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-1 ${
      fieldErrors[field]
        ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
        : 'border-slate-300 focus:border-[#006633] focus:ring-[#006633]'
    }`;

  return (
    <div className="mx-auto max-w-md py-8">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <Logo size="lg" onLight className="mx-auto mb-4" />
        <h1 className="mb-1 text-2xl font-semibold text-slate-900 dark:text-white">Create your account</h1>
        <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">
          Report campus issues and follow them through to resolution.
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

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {FIELDS.map(({ name, label, type, required, placeholder, autoComplete }) => (
            <div key={name}>
              <label htmlFor={name} className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                {label}
                {required && <span className="text-red-500"> *</span>}
              </label>
              <input
                id={name}
                type={type}
                value={form[name]}
                onChange={update(name)}
                required={required}
                placeholder={placeholder}
                autoComplete={autoComplete}
                aria-invalid={Boolean(fieldErrors[name])}
                aria-describedby={fieldErrors[name] ? `${name}-error` : undefined}
                className={inputClass(name)}
              />
              {fieldErrors[name] && (
                <p id={`${name}-error`} className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {fieldErrors[name]}
                </p>
              )}
            </div>
          ))}

          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Email address <span className="text-red-500">*</span>
            </label>
            <input
              id="email"
              type="email"
              value={form.email}
              onChange={update('email')}
              onBlur={handleEmailBlur}
              required
              autoComplete="email"
              placeholder="you@abuad.edu.ng"
              aria-invalid={Boolean(fieldErrors.email)}
              className={inputClass('email')}
            />
            {fieldErrors.email && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{fieldErrors.email}</p>}
            {emailHint && !emailHint.allowed && (
              <p className="mt-1 flex items-start gap-1 text-xs text-amber-700">
                <Info size={13} className="mt-0.5 shrink-0" />
                {emailHint.reason}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Password <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={update('password')}
                required
                minLength={8}
                autoComplete="new-password"
                aria-describedby="password-help"
                className={`${inputClass('password')} pr-10`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 dark:text-slate-500"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <p id="password-help" className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              At least 8 characters.
            </p>
            {fieldErrors.password && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{fieldErrors.password}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#006633] px-4 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
          >
            {submitting && <Spinner size="sm" />}
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-600 dark:text-slate-400">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-[#006633] hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
