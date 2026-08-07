/**
 * Set a new password.
 *
 * Reached from the emailed link. Supabase puts a recovery token in the
 * URL fragment; `detectSessionInUrl` exchanges it for a temporary
 * session before this component renders, which is what authorises the
 * update. Without that session the page can't be used.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, AlertCircle, KeyRound } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { supabase } from '../lib/supabase.js';
import { Spinner, FullPageSpinner } from '../components/Spinner.jsx';
import { useToast } from '../context/ToastContext.jsx';

export default function ResetPassword() {
  const { updatePassword } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // The fragment is consumed asynchronously, so poll once on mount
    supabase.auth.getSession().then(({ data }) => {
      setHasSession(Boolean(data.session));
      setChecking(false);
    });
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    if (password !== confirm) {
      return setError('The two passwords don\u2019t match.');
    }
    if (password.length < 8) {
      return setError('Password must be at least 8 characters.');
    }

    setSubmitting(true);
    try {
      await updatePassword(password);
      toast.success('Password updated. You can sign in with it now.');
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (checking) return <FullPageSpinner label="Verifying your link…" />;

  if (!hasSession) {
    return (
      <div className="mx-auto max-w-md py-8">
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <AlertCircle size={40} className="mx-auto mb-4 text-amber-500" />
          <h1 className="mb-2 text-xl font-semibold text-slate-900">Link expired</h1>
          <p className="mb-6 text-sm text-slate-600">
            This reset link is invalid or has already been used. Request a new one.
          </p>
          <Link
            to="/forgot-password"
            className="inline-block rounded-lg bg-[#006633] px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            Request a new link
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md py-8">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <KeyRound size={32} className="mb-4 text-[#006633]" aria-hidden="true" />
        <h1 className="mb-1 text-2xl font-semibold text-slate-900">Choose a new password</h1>
        <p className="mb-6 text-sm text-slate-600">Make it at least 8 characters.</p>

        {error && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-700">
              New password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoFocus
                autoComplete="new-password"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 text-sm focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633]"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="confirm" className="mb-1 block text-sm font-medium text-slate-700">
              Confirm new password
            </label>
            <input
              id="confirm"
              type={showPassword ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633]"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#006633] px-4 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
          >
            {submitting && <Spinner size="sm" />}
            {submitting ? 'Updating…' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  );
}
