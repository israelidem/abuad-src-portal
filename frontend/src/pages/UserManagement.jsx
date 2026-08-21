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
import RoleBadge from '../components/RoleBadge.jsx';
import AddUserDialog from '../components/AddUserDialog.jsx';


/*
 * DEV is deliberately absent from the assignable list.
 *
 * The API refuses to grant it (only an existing DEV can), so offering it
 * in the dropdown would be an option that always fails. DEV accounts are
 * provisioned directly, and a DEV's row renders as a read-only label
 * because `canManage` returns false for it.
 */
const ROLES = ['STUDENT', 'REP', 'ADMIN', 'SUPER_ADMIN'];

const ROLE_STYLES = {
  STUDENT: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  REP: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  ADMIN: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300',
  SUPER_ADMIN: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  // Cyan for DEV, matching the diamond badge's palette.
  DEV: 'bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-300',
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
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(
    async (signal) => {
      setLoading(true);
      try {
        // `search`, not `q`. The API reads `req.query.search` — this sent
        // `q` and had done since the page was written, so the search box
        // silently returned the unfiltered list and looked like it had
        // simply found everything.
        const data = await adminApi.users({ page, search: query || undefined }, { signal });
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

  /**
   * Mirrors the API's assertCanManage so we don't offer doomed actions.
   *
   * The DEV clause is the UI half of requirement 7: a DEV account is not
   * manageable by anyone but another DEV, so a super admin sees a
   * read-only label instead of a role dropdown and a "Deactivate" link.
   *
   * This is presentation only. assertCanManage refuses the same
   * combination on PATCH /users/:id/role and /users/:id/status, so a
   * hand-crafted request gets a 403 whatever this returns — which is the
   * point of putting the rule in both places rather than only here.
   */
  const canManage = (user) => {
    if (user.id === profile?.id) return false;
    // Protected from everyone except another DEV.
    if (user.role === 'DEV') return profile?.role === 'DEV';
    if (user.role === 'SUPER_ADMIN') return isSuperAdmin;
    return true;
  };


  /**
   * A new account belongs at the top of an unfiltered first page, and
   * nowhere else. Prepending it while a search or a later page is showing
   * would put a row in front of the admin that does not match what they
   * asked for, so reload instead and let the server decide.
   */
  const handleCreated = () => {
    if (page === 1 && !query) load();
    else {
      setPage(1);
      setQuery('');
      setSearch('');
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Users</h1>

        {/* Super admin only. The endpoint refuses everyone else, so showing
            this to an ADMIN would only offer them a 403. */}
        {isSuperAdmin && (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add New User
          </button>
        )}
      </div>

      {/* Mounted only while open, so each visit starts from a blank form
          without the dialog having to reset itself. */}
      {addOpen && (
        <AddUserDialog onClose={() => setAddOpen(false)} onCreated={handleCreated} />
      )}

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
                    <div className="flex items-center gap-1 font-medium text-slate-900 dark:text-white">
                      {user.fullName}
                      {/* Same badge as the comment and activity lists, so an
                          admin recognises a privileged account here too. */}
                      <RoleBadge role={user.role} size={13} />
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
                      <span className="text-xs text-slate-400 dark:text-slate-500">
                        {user.id === profile?.id ? 'You' : '—'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}

              {users.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-slate-500 dark:text-slate-400">
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
