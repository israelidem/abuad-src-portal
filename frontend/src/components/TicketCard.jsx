/**
 * Ticket summary card used on the list and dashboard.
 *
 * Voting is optimistic — the count updates immediately and rolls back if
 * the request fails, so the board feels responsive on slow campus Wi-Fi.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquare, ThumbsUp, MapPin, Clock, AlertTriangle, EyeOff } from 'lucide-react';
import { STATUSES, URGENCIES, CATEGORIES, timeAgo, dueLabel } from '../lib/constants.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { ticketApi } from '../lib/api.js';

export function Badge({ children, className = '' }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}

export default function TicketCard({ ticket, onVoteChange }) {
  const { isAuthenticated } = useAuth();
  const toast = useToast();

  const [voted, setVoted] = useState(ticket.hasVoted ?? false);
  const [votes, setVotes] = useState(ticket.upvoteCount ?? 0);
  const [voting, setVoting] = useState(false);

  const status = STATUSES[ticket.status] ?? STATUSES.PENDING;
  const urgency = URGENCIES[ticket.urgency] ?? URGENCIES.MEDIUM;
  const category = CATEGORIES[ticket.category]?.label ?? ticket.category;
  const due = dueLabel(ticket.dueAt);

  const handleVote = async () => {
    if (!isAuthenticated) return toast.info('Sign in to upvote issues.');
    if (voting) return;

    // Optimistic — reverted in the catch below
    const previous = { voted, votes };
    setVoted(!voted);
    setVotes((v) => v + (voted ? -1 : 1));
    setVoting(true);

    try {
      const result = await ticketApi.toggleVote(ticket.id);
      setVoted(result.hasVoted);
      setVotes(result.upvoteCount);
      onVoteChange?.(ticket.id, result);
    } catch (err) {
      setVoted(previous.voted);
      setVotes(previous.votes);
      toast.error(err.message);
    } finally {
      setVoting(false);
    }
  };

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-5 transition-shadow hover:shadow-md dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge className={status.className}>{status.label}</Badge>
        <Badge className={urgency.className}>{urgency.label}</Badge>
        <Badge className="border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">{category}</Badge>

        {ticket.isOverdue && (
          <Badge className="border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
            <AlertTriangle size={11} className="mr-1" />
            Overdue
          </Badge>
        )}
        {!ticket.isPublic && (
          <Badge className="border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
            <EyeOff size={11} className="mr-1" />
            Private
          </Badge>
        )}

        <span className="ml-auto font-mono text-xs text-slate-400 dark:text-slate-500">{ticket.ticketNumber}</span>
      </div>

      <Link to={`/tickets/${ticket.id}`} className="group block">
        <p className="mb-3 line-clamp-3 text-sm leading-relaxed text-slate-700 group-hover:text-slate-900 dark:text-slate-300">
          {ticket.description}
        </p>
      </Link>

      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        {ticket.location?.text && (
          <span className="flex items-center gap-1">
            <MapPin size={12} />
            {ticket.location.text}
          </span>
        )}
        {ticket.department && <span>{ticket.department.name}</span>}
        {due && (
          <span
            className={`flex items-center gap-1 ${ticket.isOverdue ? 'font-medium text-red-600' : ''}`}
          >
            <Clock size={12} />
            {due}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-slate-100 pt-3 dark:border-slate-800">
        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          {ticket.isAnonymous ? (
            <span className="italic">Anonymous</span>
          ) : (
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {ticket.author?.fullName ?? 'Unknown'}
            </span>
          )}
          <span aria-hidden="true">·</span>
          <time dateTime={ticket.createdAt}>{timeAgo(ticket.createdAt)}</time>
        </div>

        <div className="flex items-center gap-3">
          <Link
            to={`/tickets/${ticket.id}`}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400"
          >
            <MessageSquare size={14} />
            {ticket.commentCount ?? 0}
          </Link>

          <button
            type="button"
            onClick={handleVote}
            disabled={voting}
            aria-pressed={voted}
            aria-label={voted ? 'Remove your upvote' : 'Upvote this issue'}
            className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-60 ${
              voted
                ? 'border-[#006633] bg-[#006633]/10 text-[#006633]'
                : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700'
            }`}
          >
            <ThumbsUp size={13} />
            {votes}
          </button>
        </div>
      </div>
    </article>
  );
}
