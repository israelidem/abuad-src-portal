/**
 * Staff-only ticket controls: status, assignment, department.
 *
 * Rendered for REP/ADMIN only. The API re-checks the role on every
 * request, so this is a convenience layer rather than a security one.
 *
 * Status changes require a note, which becomes the audit trail entry —
 * "why was this closed?" should always have an answer.
 *
 * Status and department are saved in a single request. They used to be
 * two, which meant a failure on the second left the first applied: the
 * status really changed, the toast said it failed, and the select was
 * reset to a value the database no longer held.
 */

import { useEffect, useState } from 'react';
import { Settings, Check } from 'lucide-react';
import { ticketApi, departmentApi } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { STATUSES } from '../lib/constants.js';
import { Spinner } from './Spinner.jsx';

export default function StaffControls({ ticket, onUpdated }) {
  const toast = useToast();
  const { user } = useAuth();

  const [status, setStatus] = useState(ticket.status);
  const [departmentId, setDepartmentId] = useState(ticket.departmentId ?? '');
  const [note, setNote] = useState('');
  const [departments, setDepartments] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    departmentApi
      .list()
      .then((data) => setDepartments(data.departments))
      .catch(() => setDepartments([]));
  }, []);

  // Re-sync when the parent reloads the ticket, otherwise the controls
  // keep showing stale values after a successful save.
  //
  // Adjusted during render rather than in an effect: an effect would paint
  // the stale value first and then immediately repaint, and React
  // specifically documents this pattern for props-derived state.
  const incoming = { status: ticket.status, departmentId: ticket.departmentId ?? '' };
  const [synced, setSynced] = useState(incoming);

  if (synced.status !== incoming.status || synced.departmentId !== incoming.departmentId) {
    setSynced(incoming);
    setStatus(incoming.status);
    setDepartmentId(incoming.departmentId);
  }

  const statusChanged = status !== ticket.status;
  const deptChanged = departmentId !== (ticket.departmentId ?? '');
  const changed = statusChanged || deptChanged;

  const handleSave = async () => {
    if (!changed) return;

    setSaving(true);
    try {
      if (statusChanged) {
        // One request carries the status, the note and the re-route
        await ticketApi.setStatus(
          ticket.id,
          status,
          note || undefined,
          deptChanged ? departmentId || null : undefined
        );
      } else {
        await ticketApi.update(ticket.id, { departmentId: departmentId || null });
      }

      toast.success('Ticket updated.');
      setNote('');
      onUpdated?.();
    } catch (err) {
      // Don't reset the selects here. The request is atomic, so on failure
      // nothing changed and the current selection is still what the user
      // asked for — clearing it would hide their input for no reason.
      toast.error(err.displayMessage ?? err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleAssignToMe = async () => {
    // The endpoint validates assignedToId as a UUID — it has no "me"
    // shorthand, so send the real ID.
    if (!user?.id) {
      toast.error('Could not identify your account. Try reloading.');
      return;
    }

    setSaving(true);
    try {
      await ticketApi.assign(ticket.id, user.id);
      toast.success('Assigned to you.');
      onUpdated?.();
    } catch (err) {
      toast.error(err.displayMessage ?? err.message);
    } finally {
      setSaving(false);
    }
  };

  const selectClass =
    'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633]';

  return (
    <section className="mt-6 rounded-xl border-2 border-[#006633]/20 bg-[#006633]/[0.03] p-6">
      <h2 className="mb-4 flex items-center gap-2 font-semibold text-slate-900">
        <Settings size={18} className="text-[#006633]" />
        Representative controls
      </h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="staff-status" className="mb-1 block text-sm font-medium text-slate-700">
            Status
          </label>
          <select
            id="staff-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className={selectClass}
          >
            {Object.entries(STATUSES).map(([value, { label }]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="staff-dept" className="mb-1 block text-sm font-medium text-slate-700">
            Department
          </label>
          <select
            id="staff-dept"
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            className={selectClass}
          >
            <option value="">Unassigned</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {statusChanged && (
        <div className="mt-4">
          <label htmlFor="staff-note" className="mb-1 block text-sm font-medium text-slate-700">
            Note <span className="font-normal text-slate-400">(shown to the reporter)</span>
          </label>
          <textarea
            id="staff-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Explain what changed and why."
            className={selectClass}
          />
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={!changed || saving}
          className="flex items-center gap-2 rounded-lg bg-[#006633] px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
        >
          {saving ? <Spinner size="sm" /> : <Check size={15} />}
          Save changes
        </button>

        {/* Field is assignedToId; `assigneeId` never existed, so this
            button used to show even on already-assigned tickets. */}
        {!ticket.assignedToId && (
          <button
            type="button"
            onClick={handleAssignToMe}
            disabled={saving}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
          >
            Assign to me
          </button>
        )}

        {ticket.assignedToId === user?.id && (
          <span className="text-sm text-slate-500">Assigned to you</span>
        )}
      </div>
    </section>
  );
}
