/**
 * Request a password reset link.
 *
 * The old flow generated a 6-digit code in React state and compared it
 * client-side — anyone could read it in the console. Supabase now emails
 * a signed, expiring link instead.
 *
 * The confirmation is shown whether or not the address exists, so this
 * page can't be used to discover who has an account.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, AlertCircle, CheckCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { Spinner } from '../components/Spinner.jsx';

export default function ForgotPassword() {
  const { resetPassword } = useAuth();

  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      await resetPassword(email);
      setSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <div className="mx-auto max-w-md py-8">
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <CheckCircle size={40} className="mx-auto mb-4 text-green-600" />
          <h1 className="mb-2 text-xl font-semibold text-slate-900">Check your inbox</h1>
          <p className="mb-6 text-sm text-slate-600">
            If an account exists for <span className="font-medium">{email}</span>, we&apos;ve sent a
            link to reset your password. It expires in one hour.
          </p>
          <Link
            to="/login"
            className="inline-block rounded-lg bg-[#006633] px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md py-8">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <Mail size={32} className="mb-4 text-[#006633]" aria-hidden="true" />
        <h1 className="mb-1 text-2xl font-semibold text-slate-900">Reset your password</h1>
        <p className="mb-6 text-sm text-slate-600">
          Enter your email address and we&apos;ll send you a link to set a new one.
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

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-700">
              Email address
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              autoComplete="email"
              placeholder="you@abuad.edu.ng"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633]"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#006633] px-4 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
          >
            {submitting && <Spinner size="sm" />}
            {submitting ? 'Sending…' : 'Send reset link'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-600">
          Remembered it?{' '}
          <Link to="/login" className="font-medium text-[#006633] hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
