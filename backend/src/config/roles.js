/**
 * Role hierarchy — the single source of truth for "who outranks whom".
 *
 * WHY THIS FILE EXISTS
 * ------------------------------------------------------------
 * Before this, the same role list was spelled out by hand in at least
 * seven places: middleware/auth.js, ticketService.isStaffUser,
 * ticketService.isAdminUser, moderationService.canSeeHiddenComment,
 * middleware/maintenance.js, announcementRoutes and adminRoutes' Zod
 * enum. Adding SUPER_ADMIN in migration 04 required finding all of them,
 * and the comments in those files record that at least one was missed
 * (is_staff() in SQL), which left the highest-privilege role with fewer
 * permissions than the role below it.
 *
 * Adding DEV the same way would repeat that mistake, and a missed check
 * for DEV is not a cosmetic bug — it is an authorisation hole. So the
 * hierarchy is declared once, here, and every check derives from it.
 *
 * THE DEV ROLE
 * ------------------------------------------------------------
 * DEV is the maintainer's account. It has everything SUPER_ADMIN has, and
 * one extra property that SUPER_ADMIN does not: it is protected from
 * account-management actions taken by a super admin. See PROTECTED_ROLES
 * and canManageAccount below for exactly what that means and why.
 */

/** Every role the portal knows about, lowest privilege first. */
export const ROLES = ['STUDENT', 'REP', 'ADMIN', 'SUPER_ADMIN', 'DEV'];

/**
 * Numeric rank, used for "at least this privileged" comparisons.
 *
 * Ranked rather than set-based so a new role slots in without revisiting
 * every call site. DEV and SUPER_ADMIN deliberately differ in rank even
 * though they share permissions — the difference is what can be done *to*
 * them, not what they can do.
 */
const RANK = {
  STUDENT: 0,
  REP: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
  DEV: 4,
};

/** Rank of a role string, or -1 for an unknown/absent role. */
const rankOf = (role) => (role in RANK ? RANK[role] : -1);

/**
 * Roles that may act on tickets belonging to other people.
 * REP and above.
 */
export const STAFF_ROLES = ['REP', 'ADMIN', 'SUPER_ADMIN', 'DEV'];

/** Roles with moderation and user-management rights. ADMIN and above. */
export const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN', 'DEV'];

/**
 * Roles with portal-wide control: settings, maintenance mode, the audit
 * trail, manual account creation.
 *
 * DEV is included because the requirement is that DEV can do everything a
 * super admin can. This constant is what requireSuperAdmin uses, so DEV
 * gains those routes through the authorisation layer itself rather than by
 * unhiding UI.
 */
export const SUPER_ADMIN_ROLES = ['SUPER_ADMIN', 'DEV'];

/**
 * Roles that cannot be modified by another account, only by themselves or
 * by an equal.
 *
 * The rule from the brief: a Super Admin must not be able to deactivate,
 * delete, demote or otherwise revoke a DEV account. Stated as data here so
 * that every account-management endpoint can consult the same list; see
 * canManageAccount for the enforcement.
 */
export const PROTECTED_ROLES = ['DEV'];

const has = (roles, user) => Boolean(user?.role) && roles.includes(user.role);

/** REP and above. */
export const isStaffRole = (user) => has(STAFF_ROLES, user);

/** ADMIN and above. */
export const isAdminRole = (user) => has(ADMIN_ROLES, user);

/** SUPER_ADMIN and above (i.e. SUPER_ADMIN or DEV). */
export const isSuperAdminRole = (user) => has(SUPER_ADMIN_ROLES, user);

/** DEV only. */
export const isDevRole = (user) => user?.role === 'DEV';

/** True when `role` is one the portal protects from other admins. */
export const isProtectedRole = (role) => PROTECTED_ROLES.includes(role);

/**
 * Whether `actor` may perform an account-management action on `target`.
 *
 * Covers role changes, activation/deactivation and deletion — every
 * endpoint that mutates somebody else's account must route through this,
 * because a rule enforced in only one of them is not enforced at all.
 *
 * Returns a reason string on refusal rather than a bare false, so the API
 * can explain itself and the same wording appears wherever the check runs.
 *
 * The rules, in order of precedence:
 *
 *  1. Nobody manages their own account through the admin endpoints. Not a
 *     privilege question — it is how the last admin locks themselves out.
 *     (Kept from the existing assertCanManage.)
 *
 *  2. A protected role (DEV) can only be managed by an account of equal or
 *     higher rank. In practice that means only a DEV may act on a DEV, and
 *     a SUPER_ADMIN may not — which is the special rule in the brief.
 *     Expressed as rank rather than "is the actor a DEV" so that it still
 *     holds if a higher role is added later.
 *
 *  3. Otherwise the actor must outrank the target, or be equal.
 *     Equal-rank is allowed because that is the existing behaviour for
 *     SUPER_ADMIN (one super admin can demote another, with the
 *     last-super-admin floor as the backstop) and removing it would change
 *     an unrelated, working rule.
 */
export const canManageAccount = (actor, target) => {
  if (!actor || !target) return { allowed: false, reason: 'Account not found.' };

  if (actor.id === target.id) {
    return {
      allowed: false,
      reason: 'You cannot change your own role or status here.',
    };
  }

  const actorRank = rankOf(actor.role);
  const targetRank = rankOf(target.role);

  if (isProtectedRole(target.role) && actorRank < targetRank) {
    /*
     * Deliberately specific. A vague "permission denied" here would send
     * a super admin looking for a bug in their own permissions, when the
     * refusal is intentional and permanent.
     */
    return {
      allowed: false,
      reason: 'The developer account is protected and cannot be modified.',
    };
  }

  if (actorRank < targetRank) {
    return {
      allowed: false,
      reason: `Only a ${target.role.replace('_', ' ').toLowerCase()} can modify another ${target.role
        .replace('_', ' ')
        .toLowerCase()}.`,
    };
  }

  return { allowed: true, reason: null };
};

/**
 * Whether `actor` may grant `role` to somebody.
 *
 * Separate from canManageAccount because the two ask different questions:
 * that one is about the *target*, this is about the *privilege being
 * handed out*. An ADMIN passes the first check against a STUDENT but must
 * not be able to promote that student to SUPER_ADMIN.
 *
 * The rule: you cannot grant a role you do not hold. That single line
 * closes both the existing "admin promotes themselves a deputy" path and
 * the new "super admin mints a DEV to act on their behalf" one — the
 * latter matters because a DEV created by a super admin would be an
 * account they control that they are then forbidden from managing.
 */
export const canGrantRole = (actor, role) => {
  if (!ROLES.includes(role)) return { allowed: false, reason: 'Unknown role.' };

  if (rankOf(role) > rankOf(actor?.role)) {
    return {
      allowed: false,
      reason:
        role === 'DEV'
          ? 'Only a developer account can grant the developer role.'
          : `Only a ${role.replace('_', ' ').toLowerCase()} can grant ${role
              .replace('_', ' ')
              .toLowerCase()}.`,
    };
  }

  return { allowed: true, reason: null };
};
