/**
 * Application shell — header, navigation, footer.
 *
 * Nav links are filtered by role, but that's presentation only; the
 * matching routes are guarded and the API re-checks on every request.
 */

import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  ListChecks,
  PlusCircle,
  Shield,
  User,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

const FOREST_GREEN = '#006633';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, access: 'auth' },
  { to: '/tickets', label: 'Issues', icon: ListChecks, access: 'public' },
  { to: '/tickets/new', label: 'Report', icon: PlusCircle, access: 'auth' },
  { to: '/admin', label: 'Admin', icon: Shield, access: 'staff' },
];

export default function Layout() {
  const { isAuthenticated, isStaff, profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const visible = NAV.filter((item) => {
    if (item.access === 'public') return true;
    if (item.access === 'auth') return isAuthenticated;
    if (item.access === 'staff') return isStaff;
    return false;
  });

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  const linkClass = ({ isActive }) =>
    `flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
      isActive ? 'bg-white/15 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white'
    }`;

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
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
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#FAF92A] font-bold text-[#006633]">
              SRC
            </span>
            <span className="hidden font-semibold sm:block">ABUAD SRC Portal</span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
            {visible.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} className={linkClass} end={to === '/tickets'}>
                <Icon size={16} />
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="hidden items-center gap-2 md:flex">
            {isAuthenticated ? (
              <>
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

          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded-lg p-2 text-white md:hidden"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>

        {menuOpen && (
          <nav className="border-t border-white/10 px-4 pb-4 md:hidden" aria-label="Mobile">
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

      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        <Outlet />
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-6 text-center text-sm text-slate-500">
          <p>Afe Babalola University Students&apos; Representative Council</p>
          <p className="mt-1">
            Need help? Email{' '}
            <a href="mailto:src@abuad.edu.ng" className="text-[#006633] underline">
              src@abuad.edu.ng
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
