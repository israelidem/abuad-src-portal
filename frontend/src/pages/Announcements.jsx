/**
 * Announcements and polls.
 *
 * Read-only for students; staff get a composer and can close polls.
 * Poll results stay hidden until you've voted — showing the tally first
 * nudges people toward the leading option.
 */

import { useCallback, useEffect, useState } from 'react';

import { announcementApi } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { timeAgo } from '../lib/constants.js';
import { Spinner } from '../components/Spinner.jsx';

function Poll({ poll, onVoted }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const hasVoted = Boolean(poll.myVoteOptionId);
  const showResults = hasVoted || !poll.isActive;

  const vote = async (optionId) => {
    if (busy) return;
    setBusy(true);
    try {
      const { poll: updated } = await announcementApi.vote(poll.id, optionId);
      onVoted(updated);
    } catch (err) {
      toast.error(err.displayMessage);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <p className="font-medium text-slate-900 dark:text-white">{poll.question}</p>

      <div className="mt-3 space-y-2">
        {poll.options.map((option) => {
          // Guard against 0/0 on a poll nobody has voted in yet.
          const pct = poll.totalVotes
            ? Math.round((option.voteCount / poll.totalVotes) * 100)
            : 0;
          const isMine = poll.myVoteOptionId === option.id;

          return (
            <button
              key={option.id}
              type="button"
              disabled={!poll.isActive || busy}
              onClick={() => vote(option.id)}
              className={`relative w-full overflow-hidden rounded-lg border px-3 py-2 text-left text-sm transition ${
                isMine
                  ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/40'
                  : 'border-slate-200 hover:border-slate-300 dark:border-slate-700'
              } ${!poll.isActive ? 'cursor-default' : ''}`}
            >
              {showResults && (
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 bg-blue-100/60 transition-all dark:bg-blue-900/30"
                  style={{ width: `${pct}%` }}
                />
              )}

              <span className="relative flex items-center justify-between gap-3">
                <span className="text-slate-800 dark:text-slate-100">
                  {option.label}
                  {isMine && ' ✓'}
                </span>
                {showResults && (
                  <span className="shrink-0 font-medium text-slate-600 dark:text-slate-300">
                    {pct}%
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        {poll.totalVotes} {poll.totalVotes === 1 ? 'vote' : 'votes'}
        {!poll.isActive && ' · closed'}
        {poll.isActive && !hasVoted && ' · vote to see results'}
      </p>
    </div>
  );
}

function Composer({ onCreated }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [isPinned, setIsPinned] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const { announcement } = await announcementApi.create({
        title: title.trim(),
        body: body.trim(),
        isPinned,
        publish: true,
      });
      toast.success('Announcement published.');
      setTitle('');
      setBody('');
      setIsPinned(false);
      setOpen(false);
      onCreated(announcement);
    } catch (err) {
      toast.error(err.displayMessage);
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-6 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        New announcement
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="mb-6 space-y-3 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
    >
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        required
        minLength={3}
        maxLength={150}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="What do students need to know?"
        required
        minLength={3}
        maxLength={5000}
        rows={4}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
      />
      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
        <input
          type="checkbox"
          checked={isPinned}
          onChange={(e) => setIsPinned(e.target.checked)}
          className="rounded border-slate-300 dark:border-slate-700"
        />
        Pin to the top
      </label>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? <Spinner size="sm" /> : 'Publish'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Edit/delete controls, shown to staff while the window is still open.
 *
 * The countdown is driven by `editWindowMs` from the API rather than by
 * comparing `publishedAt` to the browser clock: a phone a few minutes
 * fast would otherwise show an edit button the server refuses to honour.
 */
function AnnouncementActions({ announcement, onUpdated, onDeleted }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(announcement.title);
  const [body, setBody] = useState(announcement.body);
  const [busy, setBusy] = useState(false);

  // Counts down from the server's figure, captured once on mount.
  const [remaining, setRemaining] = useState(announcement.editWindowMs ?? 0);

  useEffect(() => {
    if (remaining <= 0) return undefined;
    const startedAt = Date.now();
    const initial = remaining;

    const id = setInterval(() => {
      const left = initial - (Date.now() - startedAt);
      setRemaining(left > 0 ? left : 0);
    }, 1000);

    return () => clearInterval(id);
    // Only re-arm when the window reopens (i.e. after a save), not on
    // every tick — `remaining` changing each second would thrash the
    // interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announcement.id, announcement.editWindowMs]);

  const canEdit = remaining > 0;
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { announcement: updated } = await announcementApi.update(announcement.id, {
        title: title.trim(),
        body: body.trim(),
      });
      onUpdated(updated);
      setEditing(false);
      toast.success('Announcement updated.');
    } catch (err) {
      toast.error(err.displayMessage);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    // Deleting removes it for everyone who was notified, so make them mean it.
    if (!window.confirm('Delete this announcement? This cannot be undone.')) return;

    setBusy(true);
    try {
      await announcementApi.remove(announcement.id);
      onDeleted(announcement.id);
      toast.success('Announcement deleted.');
    } catch (err) {
      toast.error(err.displayMessage);
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <form onSubmit={save} className="mt-3 space-y-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={150}
          required
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          maxLength={5000}
          required
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-white"
        />
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-[#006633] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setTitle(announcement.title);
              setBody(announcement.body);
            }}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:text-slate-300"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="mt-3 flex items-center gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
      {canEdit ? (
        <>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs font-medium text-[#006633] hover:underline dark:text-green-400"
          >
            Edit
          </button>
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {minutes}:{String(seconds).padStart(2, '0')} left to edit
          </span>
        </>
      ) : (
        <span className="text-xs text-slate-400 dark:text-slate-500">
          Edit window closed
        </span>
      )}

      <button
        type="button"
        onClick={remove}
        disabled={busy}
        className="ml-auto text-xs font-medium text-red-600 hover:underline disabled:opacity-60 dark:text-red-400"
      >
        Delete
      </button>
    </div>
  );
}

export default function Announcements() {
  const { isStaff } = useAuth();
  const toast = useToast();

  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (signal) => {
      try {
        const data = await announcementApi.list(undefined, { signal });
        setAnnouncements(data.announcements);
      } catch (err) {
        if (err.name !== 'AbortError') toast.error(err.displayMessage);
      } finally {
        setLoading(false);
      }
    },
    [toast]
  );

  useEffect(() => {
    // Aborted on unmount so a slow response can't setState on a gone component.
    const controller = new AbortController();
    // Fetch-on-mount. Every setState in `load` happens after the await, so
    // there's no cascading render here — the rule can't see past the call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /** Swaps one poll in place so voting doesn't refetch the whole list. */
  const replacePoll = (updated) => {
    setAnnouncements((current) =>
      current.map((a) => ({
        ...a,
        polls: a.polls.map((p) => (p.id === updated.id ? updated : p)),
      }))
    );
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold text-slate-900 dark:text-white">
        Announcements
      </h1>

      {isStaff && (
        <Composer onCreated={(a) => setAnnouncements((c) => [{ ...a, polls: [] }, ...c])} />
      )}

      {announcements.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 py-12 text-center text-slate-500 dark:border-slate-700 dark:text-slate-400">
          Nothing has been posted yet.
        </p>
      ) : (
        <div className="space-y-4">
          {announcements.map((a) => (
            <article
              key={a.id}
              className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex items-start justify-between gap-4">
                <h2 className="font-semibold text-slate-900 dark:text-white">
                  {a.isPinned && <span aria-label="Pinned">📌 </span>}
                  {a.title}
                </h2>
                <time className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                  {timeAgo(a.publishedAt ?? a.createdAt)}
                </time>
              </div>

              <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">
                {a.body}
              </p>

              {a.author && (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  — {a.author.fullName}
                </p>
              )}

              {a.polls?.map((poll) => (
                <Poll key={poll.id} poll={poll} onVoted={replacePoll} />
              ))}

              {isStaff && (
                <AnnouncementActions
                  announcement={a}
                  onUpdated={(updated) =>
                    setAnnouncements((current) =>
                      current.map((item) =>
                        // Keep the polls already loaded: the update
                        // response doesn't include them.
                        item.id === updated.id ? { ...item, ...updated } : item
                      )
                    )
                  }
                  onDeleted={(id) =>
                    setAnnouncements((current) => current.filter((item) => item.id !== id))
                  }
                />
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
