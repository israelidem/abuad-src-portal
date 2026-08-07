import { Link } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

export default function Forbidden() {
  const { profile } = useAuth();

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <ShieldOff size={48} className="mb-4 text-amber-500" aria-hidden="true" />
      <h1 className="mb-2 text-2xl font-semibold text-slate-900">Not authorised</h1>
      <p className="mb-6 max-w-md text-sm text-slate-600">
        This area is for SRC representatives.
        {profile && (
          <>
            {' '}
            You&apos;re signed in as{' '}
            <span className="font-medium">{profile.role.toLowerCase()}</span>. If that looks wrong,
            ask an administrator to update your role.
          </>
        )}
      </p>
      <Link
        to="/dashboard"
        className="rounded-lg bg-[#006633] px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
