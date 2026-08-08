/**
 * Sign in.
 *
 * The old flow had a fake 6-digit OTP compared client-side and a
 * hardcoded admin password. Both are gone — Supabase handles the
 * credentials and the role comes from the database.
 */

import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { Spinner } from '../components/Spinner.jsx';
import Logo from '../components/Logo.jsx';

export default function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [form, setForm] = useState({ email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Where the guard redirected from, so we can return there
  const from = location.state?.from?.pathname ?? '/dashboard';

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      await signIn(form.email, form.password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const update = (field) => (event) =>
    setForm((prev) => ({ ...prev, [field]: event.target.value }));

  return (
    <div className="mx-auto max-w-md py-8">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <Logo size="lg" onLight className="mx-auto mb-4" />
        <h1 className="mb-1 text-2xl font-semibold text-slate-900 dark:text-white">Welcome back</h1>
        <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">Sign in to track and report campus issues.</p>

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
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Email address
            </label>
            <input
              id="email"
              type="email"
              value={form.email}
              onChange={update('email')}
              required
              autoComplete="email"
              autoFocus
              placeholder="you@abuad.edu.ng"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633] dark:border-slate-700"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={update('password')}
                required
                autoComplete="current-password"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 text-sm focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633] dark:border-slate-700"
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
          </div>

          <div className="text-right">
            <Link to="/forgot-password" className="text-sm text-[#006633] hover:underline">
              Forgot your password?
            </Link>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#006633] px-4 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
          >
            {submitting && <Spinner size="sm" />}
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-600 dark:text-slate-400">
          Don&apos;t have an account?{' '}
          <Link to="/signup" className="font-medium text-[#006633] hover:underline">
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
