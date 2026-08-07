/**
 * Display metadata for the API enums.
 *
 * Kept in one place so a status colour or label is defined once. The
 * keys must match the Prisma enums exactly — the API rejects anything
 * else.
 */

export const BRAND = {
  green: '#006633',
  yellow: '#FAF92A',
};

export const STATUSES = {
  PENDING: { label: 'Pending', className: 'bg-amber-100 text-amber-800 border-amber-200' },
  IN_PROGRESS: { label: 'In progress', className: 'bg-blue-100 text-blue-800 border-blue-200' },
  RESOLVED: { label: 'Resolved', className: 'bg-green-100 text-green-800 border-green-200' },
  CLOSED: { label: 'Closed', className: 'bg-slate-100 text-slate-700 border-slate-200' },
  REOPENED: { label: 'Reopened', className: 'bg-purple-100 text-purple-800 border-purple-200' },
};

export const URGENCIES = {
  LOW: { label: 'Low', className: 'bg-slate-100 text-slate-700 border-slate-200' },
  MEDIUM: { label: 'Medium', className: 'bg-amber-100 text-amber-800 border-amber-200' },
  HIGH: { label: 'High', className: 'bg-red-100 text-red-800 border-red-200' },
};

export const CATEGORIES = {
  ACADEMIC: { label: 'Academic' },
  ICT: { label: 'ICT & Networks' },
  INFRASTRUCTURE: { label: 'Infrastructure' },
  WELFARE: { label: 'Welfare' },
  ADMINISTRATION: { label: 'Administration' },
  OTHER: { label: 'Other' },
};

export const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'most_voted', label: 'Most upvoted' },
  { value: 'most_discussed', label: 'Most discussed' },
  { value: 'due_soon', label: 'Due soonest' },
  { value: 'urgency', label: 'Most urgent' },
];

/** "3 hours ago" — avoids a date library for one function. */
export const timeAgo = (input) => {
  if (!input) return '';
  const seconds = Math.floor((Date.now() - new Date(input).getTime()) / 1000);

  if (seconds < 60) return 'just now';

  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];

  for (const [name, secs] of units) {
    const value = Math.floor(seconds / secs);
    if (value >= 1) return `${value} ${name}${value > 1 ? 's' : ''} ago`;
  }
  return 'just now';
};

/** "in 2 days" / "3 hours overdue" — for the SLA countdown. */
export const dueLabel = (dueAt) => {
  if (!dueAt) return null;

  const diff = new Date(dueAt).getTime() - Date.now();
  const overdue = diff < 0;
  const hours = Math.floor(Math.abs(diff) / 3600000);

  if (hours < 1) return overdue ? 'overdue' : 'due within the hour';

  const days = Math.floor(hours / 24);
  const amount = days >= 1 ? `${days} day${days > 1 ? 's' : ''}` : `${hours} hour${hours > 1 ? 's' : ''}`;

  return overdue ? `${amount} overdue` : `due in ${amount}`;
};

export const formatDate = (input) =>
  input
    ? new Date(input).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '';
