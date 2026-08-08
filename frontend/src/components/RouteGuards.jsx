/**
 * Route guards.
 *
 * These improve the experience — they don't provide security. Every
 * protected endpoint re-checks the role server-side, so bypassing a
 * guard in the console gets you an empty page and a 403, not access.
 *
 * All three wait for `resolving` to settle first. That covers both the
 * initial session check *and* the window where a session exists but its
 * profile hasn't arrived yet. Redirecting during either would bounce
 * signed-in users to /login on refresh and right after sign-in.
 */

import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { FullPageSpinner } from './Spinner.jsx';

/** Requires a signed-in user. */
export function RequireAuth() {
  const { isAuthenticated, resolving } = useAuth();
  const location = useLocation();

  if (resolving) return <FullPageSpinner label="Checking your session…" />;

  // Remember where they were headed so login can send them back
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}

/** Requires REP or ADMIN. */
export function RequireStaff() {
  const { isAuthenticated, isStaff, resolving } = useAuth();
  const location = useLocation();

  if (resolving) return <FullPageSpinner label="Checking your permissions…" />;
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!isStaff) return <Navigate to="/403" replace />;

  return <Outlet />;
}

/** Requires ADMIN. */
export function RequireAdmin() {
  const { isAuthenticated, isAdmin, resolving } = useAuth();
  const location = useLocation();

  if (resolving) return <FullPageSpinner label="Checking your permissions…" />;
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!isAdmin) return <Navigate to="/403" replace />;

  return <Outlet />;
}

/** Requires SUPER_ADMIN — portal-wide settings and maintenance mode. */
export function RequireSuperAdmin() {
  const { isAuthenticated, isSuperAdmin, resolving } = useAuth();
  const location = useLocation();

  if (resolving) return <FullPageSpinner label="Checking your permissions…" />;
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!isSuperAdmin) return <Navigate to="/403" replace />;

  return <Outlet />;
}

/** Keeps signed-in users away from /login and /signup. */
export function RedirectIfAuthenticated({ children }) {
  const { isAuthenticated, resolving } = useAuth();

  if (resolving) return <FullPageSpinner />;
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;

  return children;
}
