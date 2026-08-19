/**
 * The settings registry — one description of every portal setting.
 *
 * WHY THIS EXISTS
 *
 * Settings live in a typed single-row table (app_settings), which is the
 * right shape: real column types, database-level defaults, and a Prisma
 * model the rest of the code can rely on. That part isn't the problem.
 *
 * The problem was that each setting had to be described in five places —
 * the Prisma model, the DEFAULTS object in settingsService, the Zod schema,
 * the hand-picked "safe to expose" list on GET /maintenance, and the form
 * in PortalSettings.jsx. Adding one setting meant five edits, and nothing
 * failed if you missed one.
 *
 * That is not hypothetical. During Phase 5 the DEFAULTS object and the
 * database drifted apart, and the portal quietly served defaults —
 * registration open, the domain allow-list ignored — with nothing in the
 * logs. Five hand-maintained copies of the same list is the bug.
 *
 * So this module describes each setting once, and the Zod schema, the
 * defaults, the public payload and the admin form are all derived from it.
 * A new setting is now: add a column (migration + Prisma), add an entry
 * here, enforce it wherever it applies. The validator, the defaults, the
 * API response and the UI follow automatically.
 *
 * WHAT THIS IS NOT
 *
 * This is not a key-value store. Moving settings into a JSON blob would
 * cost the type safety and database defaults that make the current table
 * trustworthy, and would be a migration with no upside. The columns stay.
 *
 * ADDING A SETTING — the rules
 *
 * 1. `enforcedBy` is required, and it is not decoration. A setting that
 *    nothing reads is worse than no setting: it tells an administrator
 *    they've changed something when they haven't. If you cannot name the
 *    file that enforces it, it does not belong here yet.
 *
 * 2. `public: true` means the value is readable *without a token*, before
 *    sign-in. Only for things the login and registration screens must
 *    render. Never for anything that describes internal policy — the
 *    domain lists are private because publishing them hands an attacker
 *    the exact shape of a valid account.
 *
 * 3. Defaults must fail open. If a setting cannot be read, the portal must
 *    stay usable: signups open, maintenance off. A settings glitch must
 *    never look like an outage to a student.
 */

/**
 * Setting groups, in the order the admin screen renders them.
 *
 * Availability is last because maintenance mode is the most disruptive
 * switch on the page, and it shouldn't sit next to the save button by
 * accident.
 */
export const GROUPS = [
  {
    id: 'general',
    label: 'General',
    description: 'How the portal identifies itself to students.',
  },
  {
    id: 'registration',
    label: 'Registration',
    description: 'Who may create an account, and with which email address.',
  },
  {
    id: 'tickets',
    label: 'Feedback & Tickets',
    description: 'What students may submit, and how much they may attach.',
  },
  {
    id: 'availability',
    label: 'Availability',
    description: 'Take the portal read-only during maintenance.',
  },
];

/**
 * Every setting, keyed by its Prisma field name.
 *
 * Fields:
 *   group       which section of the admin screen it appears in
 *   type        'boolean' | 'text' | 'number' | 'domains'
 *   default     used when the row or column cannot be read (must fail open)
 *   label       the control's label in the admin UI
 *   help        one line explaining the consequence of changing it
 *   public      readable without authentication (default false)
 *   enforcedBy  the file that actually applies it — required
 *   max         text length / numeric ceiling, mirrored into Zod
 *   nullable    null means "clear it and use the built-in wording"
 */
export const SETTINGS = {
  // --- General ---------------------------------------------------------
  portalName: {
    group: 'general',
    type: 'text',
    default: 'ABUAD SRC Portal',
    max: 80,
    label: 'Portal name',
    help: 'Shown in the browser tab and on the sign-in screen.',
    public: true, // the login screen renders it before anyone has a token
    enforcedBy: 'frontend/src/pages/Login.jsx, frontend/index.html',
  },

  supportEmail: {
    group: 'general',
    type: 'text',
    default: null,
    nullable: true,
    max: 160,
    label: 'Support contact email',
    help: 'Offered to students when registration is closed or a submission fails.',
    public: true, // shown on the closed-registration screen, pre-auth
    enforcedBy: 'frontend/src/pages/Signup.jsx',
  },

  // --- Registration ----------------------------------------------------
  allowStudentSignups: {
    group: 'registration',
    type: 'boolean',
    // Fail open. A failed settings read must not close registration.
    default: true,
    label: 'Allow student signups',
    help: 'When off, new registrations are refused. Existing accounts and sign-in are unaffected.',
    public: true, // the registration page needs it to render the closed notice
    enforcedBy: 'backend/src/services/registrationPolicy.js',
  },

  signupClosedMessage: {
    group: 'registration',
    type: 'text',
    default: null,
    nullable: true,
    max: 300,
    label: 'Message when registration is closed',
    help: 'Replaces the default wording. Leave blank for the standard notice.',
    public: true,
    enforcedBy: 'backend/src/services/registrationPolicy.js',
  },

  requireMatricNumber: {
    group: 'registration',
    type: 'boolean',
    // Fail open: defaulting this on would reject signups if settings broke.
    default: false,
    label: 'Require a matriculation number',
    help: 'When on, students must supply a matric number to register.',
    public: true, // the signup form marks the field required
    enforcedBy: 'backend/src/routes/authRoutes.js',
  },

  restrictSignupDomains: {
    group: 'registration',
    type: 'boolean',
    default: false,
    label: 'Restrict signups by email domain',
    help: 'When on, only the allowed domains below may register.',
    // Deliberately private. Publishing the policy tells an attacker the
    // exact shape of an acceptable account.
    enforcedBy: 'backend/src/services/registrationPolicy.js',
  },

  allowedDomains: {
    group: 'registration',
    type: 'domains',
    default: [],
    max: 20,
    label: 'Allowed domains',
    help: 'For example abuad.edu.ng. Only applies while the restriction above is on.',
    enforcedBy: 'backend/src/services/registrationPolicy.js',
  },

  allowSubdomains: {
    group: 'registration',
    type: 'boolean',
    default: true,
    label: 'Accept subdomains',
    help: 'Treats student.abuad.edu.ng as part of abuad.edu.ng.',
    enforcedBy: 'backend/src/services/registrationPolicy.js',
  },

  blockedDomains: {
    group: 'registration',
    type: 'domains',
    default: [],
    max: 50,
    label: 'Blocked domains',
    help: 'Always refused, even when they match an allowed domain.',
    enforcedBy: 'backend/src/services/registrationPolicy.js',
  },

  // --- Tickets ---------------------------------------------------------
  allowAnonymousTickets: {
    group: 'tickets',
    type: 'boolean',
    default: true,
    label: 'Allow anonymous submissions',
    help: 'When off, new tickets must carry the student’s name. Existing anonymous tickets stay anonymous.',
    public: true, // the submission form hides the checkbox
    enforcedBy: 'backend/src/routes/ticketRoutes.js',
  },

  maxAttachmentsPerTicket: {
    group: 'tickets',
    type: 'number',
    default: 5,
    max: 10,
    label: 'Maximum attachments per ticket',
    help: 'Applies to new submissions. Tickets already over the limit are untouched.',
    public: true, // the picker enforces it client-side too, as a courtesy
    enforcedBy: 'backend/src/routes/ticketRoutes.js',
  },

  // --- Availability ----------------------------------------------------
  maintenanceMode: {
    group: 'availability',
    type: 'boolean',
    // Fail open. Defaulting this on would wall off the portal on a blip.
    default: false,
    label: 'Maintenance mode',
    help: 'Students can read but not submit. Staff keep working so they can verify the change.',
    public: true, // every client renders the banner, signed in or not
    enforcedBy: 'backend/src/middleware/maintenance.js',
  },

  maintenanceMessage: {
    group: 'availability',
    type: 'text',
    default: null,
    nullable: true,
    max: 300,
    label: 'Maintenance message',
    help: 'Shown in the banner while maintenance mode is on.',
    public: true,
    enforcedBy: 'backend/src/middleware/maintenance.js',
  },
};

/** Every setting key. */
export const SETTING_KEYS = Object.keys(SETTINGS);

/**
 * Defaults, derived rather than hand-maintained.
 *
 * This replaces the DEFAULTS object that drifted from the database during
 * Phase 5. `id` is included because the settings row is a singleton pinned
 * to 1 and callers destructure the whole row.
 */
export const SETTING_DEFAULTS = Object.freeze(
  SETTING_KEYS.reduce(
    (acc, key) => {
      const { default: value } = SETTINGS[key];
      // Arrays are copied per-read so a caller mutating the result cannot
      // poison the defaults for every later request.
      acc[key] = Array.isArray(value) ? [...value] : value;
      return acc;
    },
    { id: 1 }
  )
);

/** Keys readable without a token, for the pre-sign-in screens. */
export const PUBLIC_SETTING_KEYS = SETTING_KEYS.filter((key) => SETTINGS[key].public);

/**
 * Narrows a settings row to the publicly safe fields.
 *
 * Allow-list, not deny-list: a new column is private until someone marks
 * it public in the registry, so forgetting to think about exposure fails
 * closed instead of leaking.
 */
export const toPublicSettings = (settings) =>
  PUBLIC_SETTING_KEYS.reduce((acc, key) => {
    acc[key] = settings?.[key] ?? SETTING_DEFAULTS[key];
    return acc;
  }, {});

/**
 * The registry as the admin UI needs it: grouped, ordered, no defaults
 * or enforcement notes (those are server-side concerns).
 *
 * Serving this means the form is data-driven — a new setting appears in
 * the UI without a frontend release.
 */
export const settingsManifest = () =>
  GROUPS.map((group) => ({
    ...group,
    settings: SETTING_KEYS.filter((key) => SETTINGS[key].group === group.id).map((key) => {
      const { type, label, help, max, nullable } = SETTINGS[key];
      return { key, type, label, help, max, nullable: Boolean(nullable) };
    }),
  })).filter((group) => group.settings.length > 0);
