/**
 * Application shell — header, navigation, footer.
 *
 * Nav links are filtered by role, but that's presentation only; the
 * matching routes are guarded and the API re-checks on every request.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  ListChecks,
  Megaphone,
  PlusCircle,
  Shield,
  User,
  LogOut,
  Menu,
  X,
  BarChart3,
  Users,
  Settings,
  ShieldAlert,
  ChevronDown,
  Building2,
  Code2,
  MessageSquareWarning,
  Star,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { adminApi } from '../lib/api.js';
import Logo from './Logo.jsx';
import NotificationBell from './NotificationBell.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import ContactDeveloper from './ContactDeveloper.jsx';
import RatingPrompt from './RatingPrompt.jsx';

const FOREST_GREEN = '#006633';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, access: 'auth' },
  { to: '/tickets', label: 'Issues', icon: ListChecks, access: 'public' },
  { to: '/announcements', label: 'News', icon: Megaphone, access: 'public' },
  { to: '/tickets/new', label: 'Report', icon: PlusCircle, access: 'auth' },
  /**
   * §9. Sits beside "Report" deliberately: the two are adjacent in the
   * user's mind ("something is wrong") and putting them side by side is
   * what makes the labels do the disambiguating — "Report" raises an SRC
   * issue, "Feedback" reports a fault in the website itself.
   */
  { to: '/feedback', label: 'Feedback', icon: MessageSquareWarning, access: 'auth' },
];

/**
 * Admin pages live behind a dropdown rather than in the main bar.
 *
 * They were previously routed but linked from nowhere, which made
 * analytics, user management and the maintenance toggle reachable only
 * by typing the URL. Grouping them keeps the top bar short while still
 * surfacing them.
 */
const ADMIN_NAV = [
  { to: '/admin', label: 'Overview', icon: Shield, access: 'staff' },
  { to: '/admin/analytics', label: 'Analytics', icon: BarChart3, access: 'staff' },
  { to: '/admin/users', label: 'Users', icon: Users, access: 'staff' },
  { to: '/admin/moderation', label: 'Moderation', icon: ShieldAlert, access: 'admin' },
  /**
   * Staff, not admin: reviewing bug reports and ratings needs no ability
   * to unmask an anonymous author, so it matches the requireStaff guard on
   * GET /api/feedback rather than the stricter moderation guard.
   */
  { to: '/admin/feedback', label: 'Feedback & ratings', icon: Star, access: 'staff' },
  { to: '/admin/departments', label: 'Departments', icon: Building2, access: 'admin' },
  { to: '/admin/settings', label: 'Portal settings', icon: Settings, access: 'superadmin' },
];

const linkClass = ({ isActive }) =>
  `flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    isActive ? 'bg-white/15 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white'
  }`;

/** Desktop-only dropdown grouping the admin pages. */
function AdminMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close on outside click and on Escape, so the panel can't be left
  // hanging over the page after navigating away with the keyboard.
  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-white/75 transition-colors hover:bg-white/10 hover:text-white"
      >
        <Shield size={16} />
        Admin
        <ChevronDown size={14} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 w-52 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/admin'}
              role="menuitem"
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-slate-100 font-medium text-slate-900 dark:bg-slate-800 dark:text-white'
                    : 'text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800'
                }`
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { isAuthenticated, isStaff, isAdmin, isSuperAdmin, profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [maintenance, setMaintenance] = useState(null);

  // Lives in the shell rather than the footer so the dialog renders as a
  // sibling of <footer>, not inside it — a fixed-position child of a
  // bordered footer inherits stacking context and clips oddly on iOS.
  const [contactOpen, setContactOpen] = useState(false);

  // Public endpoint, so the banner also shows on the sign-in page — which
  // is exactly where someone who can't submit will end up looking.
  useEffect(() => {
    const controller = new AbortController();

    adminApi
      .maintenance({ signal: controller.signal })
      .then((data) => setMaintenance(data.maintenanceMode ? data : null))
      .catch(() => {
        // A failed check must not block the app; assume normal operation.
      });

    return () => controller.abort();
  }, []);

  const visible = NAV.filter((item) => {
    if (item.access === 'public') return true;
    if (item.access === 'auth') return isAuthenticated;
    if (item.access === 'staff') return isStaff;
    return false;
  });

  // Portal settings can lock everyone out, so it stays SUPER_ADMIN-only —
  // matching RequireSuperAdmin on the route itself.
  const adminLinks = ADMIN_NAV.filter((item) => {
    if (item.access === 'superadmin') return isSuperAdmin;
    if (item.access === 'admin') return isAdmin;
    return isStaff;
  });

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 dark:bg-slate-950">
      {/* Keyboard users can jump straight to content */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold"
      >
        Skip to content
      </a>

      <header style={{ backgroundColor: FOREST_GREEN }} className="sticky top-0 z-40 shadow-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2 text-white">
            <Logo size="sm" />
            <span className="hidden font-semibold sm:block">ABUAD SRC Portal</span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
            {visible.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} className={linkClass} end={to === '/tickets'}>
                <Icon size={16} />
                {label}
              </NavLink>
            ))}
            <AdminMenu items={adminLinks} />
          </nav>

          <div className="hidden items-center gap-2 md:flex">
            <ThemeToggle />

            {isAuthenticated ? (
              <>
                {/* Signed-in only — the endpoint is per-user and 401s
                    without a session. */}
                <NotificationBell />
                <Link
                  to="/profile"
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white/75 hover:bg-white/10 hover:text-white"
                >
                  <User size={16} />
                  <span className="max-w-[10rem] truncate">
                    {profile?.fullName ?? 'Profile'}
                  </span>
                </Link>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white/75 hover:bg-white/10 hover:text-white"
                >
                  <LogOut size={16} />
                  Sign out
                </button>
              </>
            ) : (
              <>
                <Link
                  to="/login"
                  className="rounded-lg px-3 py-2 text-sm font-medium text-white/85 hover:bg-white/10"
                >
                  Sign in
                </Link>
                <Link
                  to="/signup"
                  className="rounded-lg bg-[#FAF92A] px-4 py-2 text-sm font-semibold text-[#006633] hover:brightness-95"
                >
                  Create account
                </Link>
              </>
            )}
          </div>

          {/*
            Mobile header controls.
            ----------------------
            The bell used to live only in the `hidden md:flex` cluster
            above, so below 768px it was display:none — and the collapsed
            menu never rendered it either. On a phone the notification
            feature simply did not exist, which is the reported bug.

            It sits outside the collapsible menu deliberately: an unread
            badge is only useful if it is visible without first opening a
            menu, and it is the one control students check most often.
          */}
          <div className="flex items-center gap-1 md:hidden">
            {isAuthenticated && <NotificationBell />}

            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              // h-11/w-11 to match the bell: two adjacent 44px targets
              // cannot be mis-tapped for one another the way a 34px pair
              // can.
              className="flex h-11 w-11 items-center justify-center rounded-lg text-white"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
            >
              {menuOpen ? <X size={22} /> : <Menu size={22} />}
            </button>
          </div>

        </div>

        {menuOpen && (
          <nav
            id="mobile-nav"
            className="border-t border-white/10 px-4 pb-4 md:hidden"
            aria-label="Mobile"
          >

            <div className="flex flex-col gap-1 pt-3">
              {visible.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={linkClass}
                  onClick={() => setMenuOpen(false)}
                  end={to === '/tickets'}
                >
                  <Icon size={16} />
                  {label}
                </NavLink>
              ))}

              {adminLinks.length > 0 && (
                <div className="mt-2 border-t border-white/10 pt-2">
                  <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-white/50">
                    Admin
                  </p>
                  {adminLinks.map(({ to, label, icon: Icon }) => (
                    <NavLink
                      key={to}
                      to={to}
                      end={to === '/admin'}
                      className={linkClass}
                      onClick={() => setMenuOpen(false)}
                    >
                      <Icon size={16} />
                      {label}
                    </NavLink>
                  ))}
                </div>
              )}

              <div className="mt-2 flex justify-center border-t border-white/10 pt-3">
                <ThemeToggle />
              </div>

              <div className="mt-2 border-t border-white/10 pt-2">
                {isAuthenticated ? (
                  <>
                    <NavLink to="/profile" className={linkClass} onClick={() => setMenuOpen(false)}>
                      <User size={16} />
                      {profile?.fullName ?? 'Profile'}
                    </NavLink>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        handleSignOut();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-white/75 hover:bg-white/10"
                    >
                      <LogOut size={16} />
                      Sign out
                    </button>
                  </>
                ) : (
                  <>
                    <NavLink to="/login" className={linkClass} onClick={() => setMenuOpen(false)}>
                      Sign in
                    </NavLink>
                    <NavLink to="/signup" className={linkClass} onClick={() => setMenuOpen(false)}>
                      Create account
                    </NavLink>
                  </>
                )}
              </div>
            </div>
          </nav>
        )}
      </header>

      {maintenance && (
        <div
          role="status"
          className="border-b border-amber-300 bg-amber-100 px-4 py-2 text-center text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          {maintenance.maintenanceMessage ||
            'The portal is in maintenance mode. You can browse, but new reports and comments are paused.'}
        </div>
      )}

      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        <Outlet />
      </main>

      <footer className="border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto max-w-7xl px-4 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
          <p>Afe Babalola University Students&apos; Representative Council</p>
          <p className="mt-1">
            Need help? Email{' '}
            <a href="mailto:src@abuad.edu.ng" className="text-[#006633] underline">
              src@abuad.edu.ng
            </a>
          </p>

          {/* Separate from the SRC address above on purpose: students were
              emailing the council about broken pages, which is a different
              queue from a portal bug. */}
          <p className="mt-2">
            <button
              type="button"
              onClick={() => setContactOpen(true)}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-slate-600 underline decoration-1 underline-offset-2 hover:text-[#006633] hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006633] dark:text-slate-400 dark:hover:text-green-400"
            >
              <Code2 size={14} aria-hidden="true" />
              Contact developer
            </button>
          </p>
        </div>
      </footer>

      <ContactDeveloper open={contactOpen} onClose={() => setContactOpen(false)} />

      {/*
        §10. Mounted in the shell so the timer survives navigation — a
        per-page mount would restart the countdown on every click and the
        prompt would never reach its threshold for an active user.

        It renders null unless the server says to ask, so for the vast
        majority of page views this costs one cached request and nothing
        else. Only for signed-in users: the endpoint requires a session.
      */}
      {isAuthenticated && <RatingPrompt />}
    </div>
  );
}
