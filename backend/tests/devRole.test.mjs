/**
 * The DEV role — inherited permissions and account protection
 * (requirement 7).
 *
 * WHY THE HIERARCHY IS TESTED RATHER THAN THE ENDPOINTS
 * ------------------------------------------------------------
 * The failure mode this guards against is specific and has happened in
 * this codebase before: migration 04 added SUPER_ADMIN and one of the
 * seven hand-written role lists was missed, which left the *highest*
 * privilege role with fewer rights than the one below it. config/roles.js
 * exists so that list is written once, and these tests assert the two
 * properties every call site now inherits:
 *
 *   1. DEV can do everything SUPER_ADMIN can (permission inheritance).
 *   2. SUPER_ADMIN cannot manage a DEV account (protection).
 *
 * Property 2 is checked through canManageAccount and canGrantRole because
 * every account-management endpoint routes through them — a rule enforced
 * in only one endpoint is not enforced at all. The database triggers in
 * 05_dev_role.sql are the third layer and are verified by the queries at
 * the end of that file, since they need a live Postgres.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ROLES,
  STAFF_ROLES,
  ADMIN_ROLES,
  SUPER_ADMIN_ROLES,
  PROTECTED_ROLES,
  isStaffRole,
  isAdminRole,
  isSuperAdminRole,
  isDevRole,
  isProtectedRole,
  canManageAccount,
  canGrantRole,
} from '../src/config/roles.js';

const user = (role, id = `${role.toLowerCase()}-1`) => ({ id, role });

const student = user('STUDENT');
const rep = user('REP');
const admin = user('ADMIN');
const superAdmin = user('SUPER_ADMIN');
const dev = user('DEV');
const otherDev = user('DEV', 'dev-2');
const otherSuperAdmin = user('SUPER_ADMIN', 'sa-2');

// ------------------------------------------------------------
// Permission inheritance
// ------------------------------------------------------------

describe('DEV inherits every SUPER_ADMIN permission', () => {
  test('DEV is a known role', () => {
    assert.equal(ROLES.includes('DEV'), true);
  });

  test('every list that contains SUPER_ADMIN also contains DEV', () => {
    /*
     * This is the invariant that prevents the migration-04 mistake from
     * recurring. Rather than trusting that each list was updated, assert
     * the relationship directly: DEV must appear wherever SUPER_ADMIN
     * does, because the requirement is "DEV can do everything a Super
     * Admin can".
     */
    for (const [name, list] of Object.entries({
      STAFF_ROLES,
      ADMIN_ROLES,
      SUPER_ADMIN_ROLES,
    })) {
      if (list.includes('SUPER_ADMIN')) {
        assert.equal(list.includes('DEV'), true, `${name} must include DEV`);
      }
    }
  });

  test('the role predicates all accept DEV', () => {
    // These four are what the middleware and services call; a false here
    // is a route DEV would be locked out of.
    assert.equal(isStaffRole(dev), true);
    assert.equal(isAdminRole(dev), true);
    assert.equal(isSuperAdminRole(dev), true);
    assert.equal(isDevRole(dev), true);
  });

  test('DEV and SUPER_ADMIN are indistinguishable to permission checks', () => {
    // Stated as an equivalence so that a future permission predicate that
    // treats them differently by accident fails here rather than in
    // production.
    for (const predicate of [isStaffRole, isAdminRole, isSuperAdminRole]) {
      assert.equal(
        predicate(dev),
        predicate(superAdmin),
        `${predicate.name} must answer the same for DEV and SUPER_ADMIN`
      );
    }
  });

  test('DEV is the only role that also counts as DEV', () => {
    for (const role of ['STUDENT', 'REP', 'ADMIN', 'SUPER_ADMIN']) {
      assert.equal(isDevRole(user(role)), false, `${role} must not read as DEV`);
    }
  });

  test('lower roles do not gain super-admin rights', () => {
    // Guards the other direction: widening the lists to admit DEV must not
    // have admitted anybody else.
    assert.equal(isSuperAdminRole(admin), false);
    assert.equal(isSuperAdminRole(rep), false);
    assert.equal(isSuperAdminRole(student), false);
    assert.equal(isAdminRole(rep), false);
    assert.equal(isStaffRole(student), false);
  });

  test('a missing or unknown role grants nothing', () => {
    for (const subject of [null, undefined, {}, { role: 'ROOT' }, { role: '' }]) {
      assert.equal(isStaffRole(subject), false);
      assert.equal(isAdminRole(subject), false);
      assert.equal(isSuperAdminRole(subject), false);
      assert.equal(isDevRole(subject), false);
    }
  });
});

// ------------------------------------------------------------
// Protection from account management
// ------------------------------------------------------------

describe('a DEV account is protected from super admins', () => {
  test('DEV is the protected role', () => {
    assert.deepEqual(PROTECTED_ROLES, ['DEV']);
    assert.equal(isProtectedRole('DEV'), true);
    assert.equal(isProtectedRole('SUPER_ADMIN'), false);
  });

  test('a super admin cannot manage a DEV account', () => {
    // Covers deactivate, delete, demote and role change in one: all four
    // endpoints call canManageAccount before touching the row.
    const gate = canManageAccount(superAdmin, dev);
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /developer account is protected/i);
  });

  test('nor can an admin, a rep or a student', () => {
    for (const actor of [admin, rep, student]) {
      assert.equal(
        canManageAccount(actor, dev).allowed,
        false,
        `${actor.role} must not manage a DEV`
      );
    }
  });

  test('the refusal says why, so it does not look like a bug', () => {
    // A vague "permission denied" would send a super admin hunting for a
    // fault in their own account; the refusal is intentional and permanent.
    assert.match(canManageAccount(superAdmin, dev).reason, /protected/i);
  });

  test('a DEV may manage another DEV', () => {
    // Equal rank is permitted, matching the existing super-admin rule.
    // Without this there would be no way to retire a stale DEV account.
    assert.equal(canManageAccount(dev, otherDev).allowed, true);
  });

  test('nobody manages their own account here', () => {
    // Pre-existing rule, preserved: this is how the last admin locks
    // themselves out. Checked before the protection rule, so a DEV acting
    // on itself gets the self-management message, not the protection one.
    for (const actor of [dev, superAdmin, admin]) {
      const gate = canManageAccount(actor, actor);
      assert.equal(gate.allowed, false);
      assert.match(gate.reason, /your own/i);
    }
  });

  test('DEV can still manage everyone below it', () => {
    for (const target of [superAdmin, admin, rep, student]) {
      assert.equal(
        canManageAccount(dev, target).allowed,
        true,
        `DEV must be able to manage ${target.role}`
      );
    }
  });

  test('existing super-admin behaviour is unchanged', () => {
    // The brief says not to break what works. A super admin still manages
    // admins, reps, students and peer super admins exactly as before.
    for (const target of [otherSuperAdmin, admin, rep, student]) {
      assert.equal(
        canManageAccount(superAdmin, target).allowed,
        true,
        `SUPER_ADMIN must still manage ${target.role}`
      );
    }
  });

  test('an admin cannot manage a super admin', () => {
    // Rank still applies below the protected tier.
    assert.equal(canManageAccount(admin, superAdmin).allowed, false);
    assert.equal(canManageAccount(rep, admin).allowed, false);
  });

  test('a missing actor or target is refused, not crashed', () => {
    // A crafted request naming a deleted user must not throw a TypeError
    // inside the authorisation check.
    for (const [actor, target] of [
      [null, dev],
      [superAdmin, null],
      [undefined, undefined],
    ]) {
      const gate = canManageAccount(actor, target);
      assert.equal(gate.allowed, false);
      assert.equal(typeof gate.reason, 'string');
    }
  });
});

// ------------------------------------------------------------
// Privilege escalation through role granting
// ------------------------------------------------------------

describe('granting roles', () => {
  test('a super admin cannot mint a DEV', () => {
    /*
     * The loophole this closes: a super admin who could create a DEV would
     * own an account they are then forbidden from managing — protection
     * turned into a privilege-escalation tool.
     */
    const gate = canGrantRole(superAdmin, 'DEV');
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /only a developer account/i);
  });

  test('only a DEV can grant DEV', () => {
    assert.equal(canGrantRole(dev, 'DEV').allowed, true);
    for (const actor of [superAdmin, admin, rep, student, null]) {
      assert.equal(
        canGrantRole(actor, 'DEV').allowed,
        false,
        `${actor?.role ?? 'anonymous'} must not grant DEV`
      );
    }
  });

  test('you cannot grant a role you do not hold', () => {
    // One rule, two holes closed: "admin appoints a deputy admin" and
    // "super admin mints a DEV".
    assert.equal(canGrantRole(admin, 'SUPER_ADMIN').allowed, false);
    assert.equal(canGrantRole(rep, 'ADMIN').allowed, false);
    assert.equal(canGrantRole(student, 'REP').allowed, false);
  });

  test('granting at or below your own rank is allowed', () => {
    assert.equal(canGrantRole(superAdmin, 'SUPER_ADMIN').allowed, true);
    assert.equal(canGrantRole(superAdmin, 'ADMIN').allowed, true);
    assert.equal(canGrantRole(admin, 'REP').allowed, true);
    assert.equal(canGrantRole(admin, 'STUDENT').allowed, true);
  });

  test('an unknown role is rejected outright', () => {
    // Prevents a crafted body inventing a role name that later slips into
    // an enum or a permission list.
    for (const role of ['ROOT', 'dev', 'Dev', '', 'SUPERADMIN']) {
      const gate = canGrantRole(dev, role);
      assert.equal(gate.allowed, false, `"${role}" must not be grantable`);
      assert.match(gate.reason, /unknown role/i);
    }
  });

  test('an anonymous caller can grant nothing', () => {
    // rankOf returns -1 for an absent role, so every real role outranks
    // "no actor" and the loop needs no special case.
    for (const role of ROLES) {
      assert.equal(
        canGrantRole(null, role).allowed,
        false,
        `an unauthenticated caller must not grant ${role}`
      );
    }
  });

});
