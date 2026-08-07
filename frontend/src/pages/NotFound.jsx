import { Link } from 'react-router-dom';
import { FileQuestion } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <FileQuestion size={48} className="mb-4 text-slate-400" aria-hidden="true" />
      <h1 className="mb-2 text-2xl font-semibold text-slate-900">Page not found</h1>
      <p className="mb-6 max-w-sm text-sm text-slate-600">
        The page you&apos;re looking for doesn&apos;t exist, or the ticket may have been removed.
      </p>
      <div className="flex gap-3">
        <Link
          to="/tickets"
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50"
        >
          Browse issues
        </Link>
        <Link
          to="/"
          className="rounded-lg bg-[#006633] px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
