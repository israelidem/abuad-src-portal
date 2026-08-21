/**
 * Verification badge for privileged accounts.
 *
 * One component, used everywhere a name is rendered — comments, the
 * activity timeline, the profile page, the admin user table. Before this
 * there was an inline `role !== 'STUDENT' ? 'Admin' : 'SRC Rep'` ternary in
 * TicketDetail that mislabelled a SUPER_ADMIN as "SRC Rep", which is the
 * usual outcome of duplicating this logic per screen.
 *
 * WHERE THE ROLE COMES FROM
 * ------------------------------------------------------------
 * `role` is whatever the API serialised from `profiles.role`. It is never
 * read from a client-writable field: authorSelect on the backend picks the
 * column directly, and no endpoint accepts a role from the browser (see
 * the note in authSchemas.js and canGrantRole in config/roles.js).
 *
 * This component decides *appearance* only. Nothing is authorised by the
 * presence of a badge, so a tampered role in a devtools-edited response
 * changes a colour and nothing else.
 *
 * DESIGN
 * ------------------------------------------------------------
 * A rounded starburst with a check — the familiar "verified" silhouette
 * without copying any platform's exact mark. Rendered as an inline SVG at
 * text size so it sits on the baseline next to a name and scales with the
 * surrounding type rather than fighting it.
 */

const ROLE_BADGES = {
  DEV: {
    label: 'Developer',
    // Diamond: a cool cyan-to-violet gradient, the only badge that uses
    // two hues, so the rarest role is also the most distinct at a glance.
    title: 'Verified developer account',
    gradient: ['#67e8f9', '#a78bfa'],
    check: '#0f172a',
  },
  SUPER_ADMIN: {
    label: 'Super Admin',
    title: 'Verified super administrator',
    gradient: ['#fbbf24', '#d97706'],
    check: '#ffffff',
  },
  ADMIN: {
    label: 'Admin',
    title: 'Verified administrator',
    gradient: ['#cbd5e1', '#94a3b8'],
    check: '#ffffff',
  },
  REP: {
    label: 'SRC Rep',
    title: 'Verified SRC representative',
    gradient: ['#60a5fa', '#2563eb'],
    check: '#ffffff',
  },
};

/**
 * Ids must be unique per gradient, not per instance: two <defs> sharing an
 * id in one document makes the second silently reuse the first's stops.
 * Keying by role gives one stable id per variant no matter how many badges
 * are on screen.
 */
const gradientId = (role) => `role-badge-${role.toLowerCase()}`;

export default function RoleBadge({ role, size = 14, showLabel = false, className = '' }) {
  const badge = ROLE_BADGES[role];

  // Students and unknown/absent roles render nothing at all. Returning
  // null rather than an empty span keeps the parent's flex gap from
  // opening a hole next to every student's name.
  if (!badge) return null;

  const [from, to] = badge.gradient;
  const id = gradientId(role);

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 align-middle ${className}`}
      // The accessible name. `title` alone is not announced reliably by
      // screen readers, and colour alone would carry the meaning for
      // nobody who cannot see it — hence both, plus the optional text
      // label below.
      title={badge.title}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        role="img"
        aria-label={badge.title}
        className="shrink-0"
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
        </defs>
        {/*
          A 12-point rounded starburst. Drawn as one path so it stays crisp
          at 12px, where a multi-element mark turns to mush.
        */}
        <path
          fill={`url(#${id})`}
          d="M12 1.6l2.2 2.06 2.98-.44 1.16 2.78 2.78 1.16-.44 2.98L22.4 12l-2.06 2.2.44 2.98-2.78 1.16-1.16 2.78-2.98-.44L12 22.4l-2.2-2.06-2.98.44-1.16-2.78-2.78-1.16.44-2.98L1.6 12l2.06-2.2-.44-2.98 2.78-1.16 1.16-2.78 2.98.44z"
        />
        <path
          fill="none"
          stroke={badge.check}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M8.2 12.2l2.6 2.6 5-5.4"
        />
      </svg>

      {/*
        Off by default. Next to a name in a dense comment thread the mark
        alone is enough, but the profile page and the admin table ask for
        the word — so the text is a prop rather than a second component.
      */}
      {showLabel && (
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
          {badge.label}
        </span>
      )}
    </span>
  );
}

/**
 * Name + badge, the pairing this is needed for in practice.
 *
 * Exported because "render the name, then the badge, in a flex row that
 * does not wrap between them" was being retyped at every call site, and
 * that is exactly how one screen ends up with the badge on its own line.
 */
export function UserName({ name, role, fallback = 'Anonymous', size = 13, className = '' }) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${className}`}>
      {/* truncate + min-w-0: a long name must shorten rather than push the
          badge out of a narrow mobile card. */}
      <span className="truncate">{name || fallback}</span>
      <RoleBadge role={role} size={size} />
    </span>
  );
}

export { ROLE_BADGES };
