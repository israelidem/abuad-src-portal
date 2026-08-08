/**
 * User management — roles and access.
 *
 * The dangerous actions (demoting the last super admin, deactivating
 * yourself) are refused by the API. This page mirrors those rules in the
 * UI so the buttons that would fail are simply not offered, but the
 * server remains the authority.
 */

import { useCallback, useEffect, useState } from 'react';

import { adminApi } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Spinner } from '../components/Spinner.jsx';

const ROLES = ['STUDENT', 'REP', 'ADMIN', 'SUPER_ADMIN'];

const ROLE_STYLES = {
  STUDENT: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  REP: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  ADMIN: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300',
  SUPER_ADMIN: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
};

export default function UserManagement() {
  const { profile, isSuperAdmin } = useAuth();
  const toast = useToast();

  const [users, setUsers] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(
    async (signal) => {
      setLoading(true);
      try {
        const data = await adminApi.users({ page, q: query || undefined }, { signal });
        setUsers(data.users);
        setPagination(data.pagination);
      } catch (err) {
        if (err.name !== 'AbortError') toast.error(err.displayMessage);
      } finally {
        setLoading(false);
      }
    },
    [page, query, toast]
  );

  useEffect(() => {
    const controller = new AbortController();
    // Fetch-on-mount, and again when the page or search changes. `load`
    // sets `loading` synchronously so the table doesn't show the previous
    // page's rows while the next one is in flight.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const submitSearch = (event) => {
    event.preventDefault();
    setPage(1); // a filtered list has different pages; page 3 may not exist
    setQuery(search.trim());
  };

  const changeRole = async (user, role) => {
    if (role === user.role) return;
    setBusyId(user.id);
    try {
      const { user: updated } = await adminApi.setUserRole(user.id, role);
      setUsers((current) => current.map((u) => (u.id === updated.id ? { ...u, ...updated } : u)));
      toast.success(`${updated.fullName} is now ${role.replace('_', ' ').toLowerCase()}.`);
    } catch (err) {
      toast.error(err.displayMessage);
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = async (user) => {
    setBusyId(user.id);
    try {
      const { user: updated } = await adminApi.setUserStatus(user.id, !user.isActive);
      setUsers((current) => current.map((u) => (u.id === updated.id ? { ...u, ...updated } : u)));
      toast.success(updated.isActive ? 'Account reactivated.' : 'Account deactivated.');
    } catch (err) {
      toast.error(err.displayMessage);
    } finally {
      setBusyId(null);
    }
  };

  /** Mirrors the API's assertCanManage so we don't offer doomed actions. */
  const canManage = (user) =>
    user.id !== profile?.id && (user.role !== 'SUPER_ADMIN' || isSuperAdmin);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold text-slate-900 dark:text-white">Users</h1>

      <form onSubmit={submitSearch} className="mb-4 flex gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email or matric number"
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
        />
        <button
          type="submit"
          className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-900 dark:bg-slate-700"
        >
          Search
        </button>
      </form>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Reports</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white dark:divide-slate-800 dark:bg-slate-900">
              {users.map((user) => (
                <tr key={user.id} className={user.isActive ? '' : 'opacity-60'}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900 dark:text-white">
                      {user.fullName}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {user.email}
                      {user.matricNumber && ` · ${user.matricNumber}`}
                    </div>
                  </td>

                  <td className="px-4 py-3">
                    {canManage(user) ? (
                      <select
                        value={user.role}
                        disabled={busyId === user.id}
                        onChange={(e) => changeRole(user, e.target.value)}
                        aria-label={`Role for ${user.fullName}`}
                        className="rounded-lg border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                      >
                        {ROLES.map((role) => (
                          // Only a super admin can hand out SUPER_ADMIN.
                          <option
                            key={role}
                            value={role}
                            disabled={role === 'SUPER_ADMIN' && !isSuperAdmin}
                          >
                            {role.replace('_', ' ')}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span
                        className={`rounded-full px-2 py-1 text-xs font-medium ${
                          ROLE_STYLES[user.role]
                        }`}
                      >
                        {user.role.replace('_', ' ')}
                      </span>
                    )}
                  </td>

                  <td className="px-4 py-3 text-slate-600 dark:text-slate-400">
                    {user.ticketCount}
                  </td>

                  <td className="px-4 py-3">
                    {canManage(user) ? (
                      <button
                        type="button"
                        disabled={busyId === user.id}
                        onClick={() => toggleActive(user)}
                        className={`text-xs font-medium hover:underline disabled:opacity-50 ${
                          user.isActive
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-green-600 dark:text-green-400'
                        }`}
                      >
                        {user.isActive ? 'Deactivate' : 'Reactivate'}
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400">
                        {user.id === profile?.id ? 'You' : '—'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}

              {users.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-slate-500">
                    No users matched that search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {pagination && pagination.pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300"
          >
            Previous
          </button>
          <span className="text-slate-600 dark:text-slate-400">
            Page {pagination.page} of {pagination.pages}
          </span>
          <button
            type="button"
            disabled={page >= pagination.pages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
