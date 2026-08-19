/**
 * Settings registry tests.
 *
 * The registry exists because the same setting used to be described in five
 * places and nothing failed when one copy drifted (see the header comment in
 * settingsRegistry.js). Deriving them from one source removes most of that
 * risk, but two new failure modes replace it, and both are silent:
 *
 *   1. A setting is added to the registry but the column never ships, so
 *      every settings read fails on an unknown column.
 *   2. A setting is marked `public` carelessly, and internal policy — the
 *      domain allow-list — becomes readable without a token.
 *
 * These tests pin the invariants the registry's own documentation claims,
 * so the claims cannot quietly stop being true. No database or network
 * needed: the registry is pure data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GROUPS,
  SETTINGS,
  SETTING_DEFAULTS,
  PUBLIC_SETTING_KEYS,
  settingsManifest,
  toPublicSettings,
} from '../src/config/settingsRegistry.js';

test('every setting names the file that enforces it', () => {
  // Rule 1 in the registry header. A setting nothing reads is worse than no
  // setting: the admin screen reports a change that has no effect anywhere.
  for (const [key, setting] of Object.entries(SETTINGS)) {
    assert.ok(
      setting.enforcedBy && setting.enforcedBy.length > 0,
      `${key} has no enforcedBy — either enforce it or don't offer it`
    );
  }
});

test('every setting belongs to a declared group', () => {
  // A typo'd group id would drop the field from the admin form silently:
  // present in the API, absent from the page, editable only by hand.
  const groupIds = new Set(GROUPS.map((g) => g.id));

  for (const [key, setting] of Object.entries(SETTINGS)) {
    assert.ok(groupIds.has(setting.group), `${key} is in unknown group "${setting.group}"`);
  }
});

test('every setting has a default, and the defaults fail open', () => {
  // Rule 3. If settings cannot be read the portal must stay usable, so the
  // fallbacks must not be the restrictive values.
  for (const key of Object.keys(SETTINGS)) {
    assert.ok(key in SETTING_DEFAULTS, `${key} has no default value`);
  }

  assert.equal(
    SETTING_DEFAULTS.allowStudentSignups,
    true,
    'a settings failure must not close signups'
  );
  assert.equal(
    SETTING_DEFAULTS.maintenanceMode,
    false,
    'a settings failure must not look like an outage'
  );
  assert.equal(
    SETTING_DEFAULTS.allowAnonymousTickets,
    true,
    'anonymity is a core feature; default on'
  );
  assert.equal(
    SETTING_DEFAULTS.requireMatricNumber,
    false,
    'must not reject signups for a missing field'
  );
  assert.equal(
    SETTING_DEFAULTS.restrictSignupDomains,
    false,
    'defaulting to restricted with no allow-list would reject everyone'
  );
});

test('the public payload never leaks internal policy', () => {
  // Rule 2, and the one with teeth. GET /api/admin/maintenance is
  // unauthenticated, so anything marked public is world-readable.
  //
  // The domain lists describe exactly which email suffixes produce a valid
  // account — a map worth having if you are trying to make one.
  const mustStayPrivate = [
    'allowedDomains',
    'blockedDomains',
    'restrictSignupDomains',
    'allowSubdomains',
  ];

  for (const key of mustStayPrivate) {
    assert.ok(!PUBLIC_SETTING_KEYS.includes(key), `${key} must not be publicly readable`);
  }
});

test('toPublicSettings returns only the allow-listed keys', () => {
  // Proves the filter is an allow-list rather than a deny-list: a column
  // nobody has classified yet must default to private, so the failure mode
  // is a missing UI hint rather than a disclosure.
  const row = {
    ...SETTING_DEFAULTS,
    allowedDomains: ['abuad.edu.ng'],
    blockedDomains: ['tempmail.com'],
    updatedById: 'a-user-id',
    somethingAddedLater: 'should not appear',
  };

  const published = toPublicSettings(row);

  assert.deepEqual(
    Object.keys(published).sort(),
    [...PUBLIC_SETTING_KEYS].sort(),
    'public payload shape drifted from PUBLIC_SETTING_KEYS'
  );

  assert.ok(!('allowedDomains' in published));
  assert.ok(!('updatedById' in published));
  assert.ok(!('somethingAddedLater' in published));
});

test('the public payload carries what the pre-sign-in screens need', () => {
  // The counterpart to the leak test: too private is also a bug. The
  // registration page cannot explain that signups are closed if it can't
  // read the flag, and would show a form that always fails.
  const published = toPublicSettings(SETTING_DEFAULTS);

  for (const key of ['maintenanceMode', 'allowStudentSignups', 'portalName']) {
    assert.ok(key in published, `${key} must be readable before sign-in`);
  }
});

test('the manifest describes every setting exactly once', () => {
  // The admin form renders from this. A setting missing here is a setting
  // no administrator can change; a duplicate is two controls writing to one
  // column, where the loser silently reverts.
  const manifest = settingsManifest();
  const seen = manifest.flatMap((group) => group.settings.map((s) => s.key));

  assert.equal(seen.length, new Set(seen).size, 'a setting appears in the manifest twice');
  assert.deepEqual(
    seen.sort(),
    Object.keys(SETTINGS).sort(),
    'manifest and registry disagree about which settings exist'
  );
});

test('the manifest ships labels and help text, not enforcement details', () => {
  // The manifest is served to the browser. `enforcedBy` is a note to
  // ourselves — it names backend file paths, which is free reconnaissance.
  for (const group of settingsManifest()) {
    for (const setting of group.settings) {
      assert.ok(setting.label, `${setting.key} has no label to render`);
      assert.ok(setting.help, `${setting.key} has no help text`);
      assert.ok(
        !('enforcedBy' in setting),
        `${setting.key} exposes internal file paths to the client`
      );
    }
  }
});
