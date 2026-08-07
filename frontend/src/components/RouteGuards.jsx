/**
 * Route guards.
 *
 * These improve the experience — they don't provide security. Every
 * protected endpoint re-checks the role server-side, so bypassing a
 * guard in the console gets you an empty page and a 403, not access.
 *
 * All three wait for `loading` to settle first. Redirecting during the
 * initial session check would bounce signed-in users to /login on every
 * refresh.
 */

import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { FullPageSpinner } from './Spinner.jsx';

/** Requires a signed-in user. */
export function RequireAuth() {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner label="Checking your session…" />;

  // Remember where they were headed so login can send them back
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}

/** Requires REP or ADMIN. */
export function RequireStaff() {
  const { isAuthenticated, isStaff, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner label="Checking your permissions…" />;
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!isStaff) return <Navigate to="/403" replace />;

  return <Outlet />;
}

/** Requires ADMIN. */
export function RequireAdmin() {
  const { isAuthenticated, isAdmin, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner label="Checking your permissions…" />;
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!isAdmin) return <Navigate to="/403" replace />;

  return <Outlet />;
}

/** Keeps signed-in users away from /login and /signup. */
export function RedirectIfAuthenticated({ children }) {
  const { isAuthenticated, loading } = useAuth();

  if (loading) return <FullPageSpinner />;
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;

  return children;
}
