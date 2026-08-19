/**
 * Registration policy — is signup open, and what do we say if it isn't?
 *
 * Split out from the signup route so the decision can be tested without a
 * database, a Supabase client or an HTTP server. The route stays
 * responsible for *enforcing* the answer; this module only decides it.
 *
 * Deliberately fails open. If the settings row can't be read we allow
 * registration: a database blip should look like a slow day, not like the
 * SRC quietly closing admissions. The opposite default would turn any
 * transient error into a total signup outage that nothing alerts on.
 */

const DEFAULT_CLOSED_MESSAGE =
  'New student registrations are temporarily unavailable. Please check back later or contact the SRC.';

/**
 * Decides whether a signup attempt may proceed.
 *
 * @param {object|null|undefined} settings - the AppSettings row, or a
 *   partial/absent object if the read failed or the migration hasn't run.
 * @returns {{ allowed: boolean, reason: string|null }}
 *
 * `allowed: true` carries `reason: null` so callers can't accidentally
 * surface stale copy on the happy path.
 */
export const checkSignupAllowed = (settings) => {
  // `!== false` rather than a truthy check, so an API running against a
  // database that predates the migration (field absent → undefined) keeps
  // registration open instead of silently closing it.
  if (settings?.allowStudentSignups !== false) {
    return { allowed: true, reason: null };
  }

  // An admin-authored message wins, but only if it has real content —
  // a whitespace-only string would render as a blank explanation.
  const custom = settings.signupClosedMessage?.trim();

  return { allowed: false, reason: custom || DEFAULT_CLOSED_MESSAGE };
};

export { DEFAULT_CLOSED_MESSAGE };
