/**
 * Staff-only ticket controls: status, assignment, department.
 *
 * Rendered for REP/ADMIN only. The API re-checks the role on every
 * request, so this is a convenience layer rather than a security one.
 *
 * Status changes require a note, which becomes the audit trail entry —
 * "why was this closed?" should always have an answer.
 */

import { useEffect, useState } from 'react';
import { Settings, Check } from 'lucide-react';
import { ticketApi, departmentApi } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { STATUSES } from '../lib/constants.js';
import { Spinner } from './Spinner.jsx';

export default function StaffControls({ ticket, onUpdated }) {
  const toast = useToast();

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

  const changed = status !== ticket.status || departmentId !== (ticket.departmentId ?? '');

  const handleSave = async () => {
    if (!changed) return;

    setSaving(true);
    try {
      if (status !== ticket.status) {
        await ticketApi.setStatus(ticket.id, status, note || undefined);
      }
      if (departmentId !== (ticket.departmentId ?? '')) {
        await ticketApi.update(ticket.id, { departmentId: departmentId || null });
      }

      toast.success('Ticket updated.');
      setNote('');
      onUpdated?.();
    } catch (err) {
      toast.error(err.message);
      setStatus(ticket.status); // roll back the select
    } finally {
      setSaving(false);
    }
  };

  const handleAssignToMe = async () => {
    setSaving(true);
    try {
      // The API resolves "me" to the caller, so no ID lookup is needed
      await ticketApi.assign(ticket.id, 'me');
      toast.success('Assigned to you.');
      onUpdated?.();
    } catch (err) {
      toast.error(err.message);
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

      {status !== ticket.status && (
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

        {!ticket.assigneeId && (
          <button
            type="button"
            onClick={handleAssignToMe}
            disabled={saving}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
          >
            Assign to me
          </button>
        )}
      </div>
    </section>
  );
}
