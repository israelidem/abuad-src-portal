/**
 * Single ticket: full description, attachments, timeline and comments.
 *
 * Staff controls (status, assignment, internal notes) render only for
 * REP/ADMIN — and the API enforces the same rules, so hiding them is
 * convenience, not security.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, MapPin, Clock, ThumbsUp, Lock, Send, AlertCircle } from 'lucide-react';

import { ticketApi } from '../lib/api.js';
import { getAttachmentUrl } from '../lib/uploads.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { STATUSES, URGENCIES, CATEGORIES, timeAgo, dueLabel, formatDate } from '../lib/constants.js';
import { Badge } from '../components/TicketCard.jsx';
import { Spinner, FullPageSpinner } from '../components/Spinner.jsx';
import StaffControls from '../components/StaffControls.jsx';
import ResolutionActions from '../components/ResolutionActions.jsx';

export default function TicketDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated, isStaff } = useAuth();
  const toast = useToast();

  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [comment, setComment] = useState('');
  const [internal, setInternal] = useState(false);
  const [posting, setPosting] = useState(false);
  const [voting, setVoting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Comments and events are separate endpoints; fetched together so
      // the page renders in one pass rather than three staggered ones.
      const [{ ticket: found }, commentsResult, eventsResult] = await Promise.all([
        ticketApi.get(id),
        ticketApi.comments(id).catch(() => ({ comments: [] })),
        ticketApi.timeline(id).catch(() => ({ events: [] })),
      ]);

      setTicket({
        ...found,
        comments: commentsResult.comments ?? [],
        events: eventsResult.events ?? [],
      });
      setError(null);
    } catch (err) {
      if (err.status === 404) return navigate('/404', { replace: true });
      if (err.status === 403) return navigate('/403', { replace: true });
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id, navigate]);

  useEffect(() => {
    // Fetch-on-mount; see the note in useTickets for why the synchronous
    // loading flag is deliberate here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const handleVote = async () => {
    if (!isAuthenticated) return toast.info('Sign in to upvote.');
    setVoting(true);
    try {
      const result = await ticketApi.toggleVote(id);
      setTicket((t) => ({ ...t, ...result }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setVoting(false);
    }
  };

  const handleComment = async (event) => {
    event.preventDefault();
    if (!comment.trim()) return;

    setPosting(true);
    try {
      const { comment: created } = await ticketApi.addComment(id, comment, internal);
      setTicket((t) => ({ ...t, comments: [...(t.comments ?? []), created] }));
      setComment('');
      setInternal(false);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setPosting(false);
    }
  };

  if (loading) return <FullPageSpinner label="Loading issue…" />;

  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
        {error}
      </div>
    );
  }

  const status = STATUSES[ticket.status] ?? STATUSES.PENDING;
  const urgency = URGENCIES[ticket.urgency] ?? URGENCIES.MEDIUM;
  const due = dueLabel(ticket.dueAt);

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        to="/tickets"
        className="mb-4 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900 dark:text-slate-400"
      >
        <ArrowLeft size={16} />
        All issues
      </Link>

      <article className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Badge className={status.className}>{status.label}</Badge>
          <Badge className={urgency.className}>{urgency.label}</Badge>
          <Badge className="border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
            {CATEGORIES[ticket.category]?.label ?? ticket.category}
          </Badge>
          {ticket.isOverdue && (
            <Badge className="border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">Overdue</Badge>
          )}
          <span className="ml-auto font-mono text-xs text-slate-400 dark:text-slate-500">{ticket.ticketNumber}</span>
        </div>

        <p className="mb-5 whitespace-pre-wrap text-[15px] leading-relaxed text-slate-800 dark:text-slate-100">
          {ticket.description}
        </p>

        {ticket.attachments?.length > 0 && (
          <ul className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {ticket.attachments.map((a) => (
              <li key={a.id}>
                <a
                  href={getAttachmentUrl(a.storagePath)}
                  target="_blank"
                  rel="noreferrer"
                  className="block aspect-square overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800"
                >
                  <img
                    src={getAttachmentUrl(a.storagePath)}
                    alt="Attachment"
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform hover:scale-105"
                  />
                </a>
              </li>
            ))}
          </ul>
        )}

        <dl className="mb-5 grid grid-cols-2 gap-3 border-y border-slate-100 py-4 text-sm sm:grid-cols-4 dark:border-slate-800">
          <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">Reported by</dt>
            <dd className="mt-0.5 font-medium text-slate-800 dark:text-slate-100">
              {ticket.isAnonymous ? <span className="italic">Anonymous</span> : ticket.author?.fullName}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">Reported</dt>
            <dd className="mt-0.5 text-slate-800 dark:text-slate-100">{formatDate(ticket.createdAt)}</dd>
          </div>
          {ticket.location?.text && (
            <div>
              <dt className="text-xs text-slate-500 dark:text-slate-400">Location</dt>
              <dd className="mt-0.5 flex items-center gap-1 text-slate-800 dark:text-slate-100">
                <MapPin size={13} />
                {ticket.location.text}
              </dd>
            </div>
          )}
          {due && (
            <div>
              <dt className="text-xs text-slate-500 dark:text-slate-400">Target</dt>
              <dd className={`mt-0.5 flex items-center gap-1 ${ticket.isOverdue ? 'font-medium text-red-600' : 'text-slate-800'}`}>
                <Clock size={13} />
                {due}
              </dd>
            </div>
          )}
          {/* API field is `assignedTo`. `assignee` never existed, so this
              row never rendered even on assigned tickets. */}
          {ticket.assignedTo && (
            <div>
              <dt className="text-xs text-slate-500 dark:text-slate-400">Assigned to</dt>
              <dd className="mt-0.5 text-slate-800 dark:text-slate-100">{ticket.assignedTo.fullName}</dd>
            </div>
          )}
          {ticket.department && (
            <div>
              <dt className="text-xs text-slate-500 dark:text-slate-400">Department</dt>
              <dd className="mt-0.5 text-slate-800 dark:text-slate-100">{ticket.department.name}</dd>
            </div>
          )}
        </dl>

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={handleVote}
            disabled={voting}
            aria-pressed={ticket.hasVoted}
            className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-60 ${
              ticket.hasVoted
                ? 'border-[#006633] bg-[#006633]/10 text-[#006633]'
                : 'border-slate-300 text-slate-600 hover:bg-slate-50'
            }`}
          >
            <ThumbsUp size={15} />
            {ticket.hasVoted ? 'Upvoted' : 'Upvote'} ({ticket.upvoteCount})
          </button>
        </div>
      </article>

      {isStaff && <StaffControls ticket={ticket} onUpdated={load} />}

      {/* Renders nothing unless you're the reporter and it's resolved —
          that check lives in the component, so no duplicate here. */}
      <ResolutionActions ticket={ticket} onChanged={load} />

      {ticket.events?.length > 0 && (
        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="mb-4 font-semibold text-slate-900 dark:text-white">Activity</h2>
          <ol className="space-y-3">
            {ticket.events.map((event) => (
              <li key={event.id} className="flex gap-3 text-sm">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-slate-300" aria-hidden="true" />
                <div>
                  <p className="text-slate-700 dark:text-slate-300">
                    {event.type === 'STATUS_CHANGED' && (
                      <>
                        Status changed to{' '}
                        {/* The API returns `to` at the top level of the event;
                            `metadata` only carries the optional note. Reading
                            metadata.to left this label permanently blank. */}
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                            STATUSES[event.to]?.className ??
                            'border-slate-200 bg-slate-100 text-slate-700'
                          }`}
                        >
                          {STATUSES[event.to]?.label ?? event.to ?? 'unknown'}
                        </span>
                      </>
                    )}
                    {event.type === 'REOPENED' && 'Issue reopened'}
                    {event.type === 'ASSIGNED' && 'Assigned to a representative'}
                    {event.type === 'UNASSIGNED' && 'Assignment removed'}
                    {event.type === 'CREATED' && 'Issue reported'}
                    {event.type === 'COMMENTED' && 'New comment'}
                    {event.type === 'RATED' && 'Resolution rated'}
                    {event.type === 'ATTACHMENT_ADDED' && 'Photo added'}
                    {event.type === 'DUE_DATE_CHANGED' && 'Target date changed'}
                    {/* toName is denormalised onto the event — from/to hold
                        department UUIDs, which mean nothing to a reader. */}
                    {event.type === 'DEPARTMENT_CHANGED' && (
                      <>Routed to {event.metadata?.toName ?? 'another department'}</>
                    )}
                    {event.type === 'FLAGGED' && 'Flagged for moderation'}
                    {event.type === 'UNFLAGGED' && 'Moderation flag removed'}
                  </p>

                  {/* The note a rep leaves with a status change is the
                      "why". It was being stored and never displayed. */}
                  {event.metadata?.note && (
                    <p className="mt-1 border-l-2 border-slate-200 pl-2 text-sm italic text-slate-600 dark:border-slate-800 dark:text-slate-400">
                      {event.metadata.note}
                    </p>
                  )}

                  <p className="text-xs text-slate-400 dark:text-slate-500">
                    {event.actor?.fullName ?? 'System'} · {timeAgo(event.createdAt)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="mb-4 font-semibold text-slate-900 dark:text-white">
          Comments ({ticket.comments?.length ?? 0})
        </h2>

        {ticket.comments?.length === 0 && (
          <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">No comments yet.</p>
        )}

        <ul className="mb-5 space-y-4">
          {ticket.comments?.map((c) => (
            <li
              key={c.id}
              className={`rounded-lg p-4 ${c.isInternal ? 'border border-amber-200 bg-amber-50' : 'bg-slate-50'}`}
            >
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-slate-800 dark:text-slate-100">
                  {c.author?.fullName ?? 'Anonymous'}
                </span>
                {c.author?.role && c.author.role !== 'STUDENT' && (
                  <Badge className="border-[#006633]/20 bg-[#006633]/10 text-[#006633]">
                    {c.author.role === 'ADMIN' ? 'Admin' : 'SRC Rep'}
                  </Badge>
                )}
                {c.isInternal && (
                  <Badge className="border-amber-300 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                    <Lock size={10} className="mr-1" />
                    Internal
                  </Badge>
                )}
                <time className="ml-auto text-slate-400 dark:text-slate-500" dateTime={c.createdAt}>
                  {timeAgo(c.createdAt)}
                </time>
              </div>
              <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">{c.body}</p>
            </li>
          ))}
        </ul>

        {isAuthenticated ? (
          <form onSubmit={handleComment} className="space-y-3">
            <label htmlFor="comment" className="sr-only">
              Add a comment
            </label>
            <textarea
              id="comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              placeholder="Add an update or ask a question…"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[#006633] focus:outline-none focus:ring-1 focus:ring-[#006633] dark:border-slate-700"
            />

            <div className="flex items-center justify-between">
              {isStaff ? (
                <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                  <input
                    type="checkbox"
                    checked={internal}
                    onChange={(e) => setInternal(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-[#006633] focus:ring-[#006633] dark:border-slate-700"
                  />
                  Internal note (staff only)
                </label>
              ) : (
                <span />
              )}

              <button
                type="submit"
                disabled={posting || !comment.trim()}
                className="flex items-center gap-2 rounded-lg bg-[#006633] px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
              >
                {posting ? <Spinner size="sm" /> : <Send size={14} />}
                Post
              </button>
            </div>
          </form>
        ) : (
          <p className="flex items-center gap-2 rounded-lg bg-slate-50 p-4 text-sm text-slate-600 dark:bg-slate-900 dark:text-slate-400">
            <AlertCircle size={16} />
            <Link to="/login" className="font-medium text-[#006633] hover:underline">
              Sign in
            </Link>
            to join the discussion.
          </p>
        )}
      </section>
    </div>
  );
}
