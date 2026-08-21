/**
 * Cloudinary storage tests.
 *
 * The signature and the folder guard are the two things that actually
 * enforce security here, so they are tested against known values rather
 * than against themselves. `signParams` is checked with a fixed secret and
 * an independently computed SHA-1 — if the implementation drifts, the test
 * fails instead of agreeing with the new behaviour.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.CLOUDINARY_CLOUD_NAME ??= 'test-cloud';
process.env.CLOUDINARY_API_KEY ??= '123456789';
process.env.CLOUDINARY_API_SECRET ??= 'test-secret';

const {
  signParams,
  buildUploadSignature,
  isPublicIdWithinFolder,
  buildDeliveryUrl,
  ALLOWED_FORMATS,
  MAX_FILE_BYTES,
} = await import('../src/services/cloudinaryService.js');

describe('signParams', () => {
  it('matches an independently computed Cloudinary signature', () => {
    // Computed here by hand, not by calling the implementation: sorted
    // key=value pairs joined with &, secret appended, SHA-1.
    const expected = crypto
      .createHash('sha1')
      .update('folder=x/y&public_id=abc&timestamp=1700000000' + 'test-secret')
      .digest('hex');

    const actual = signParams(
      { timestamp: 1700000000, folder: 'x/y', public_id: 'abc' },
      'test-secret'
    );

    assert.equal(actual, expected);
  });

  it('sorts keys, so parameter order cannot change the signature', () => {
    const a = signParams({ a: 1, b: 2, c: 3 }, 's');
    const b = signParams({ c: 3, a: 1, b: 2 }, 's');
    assert.equal(a, b);
  });

  it('omits empty values, matching how Cloudinary recomputes the signature', () => {
    // If empties were included, uploads would fail with an opaque 401.
    const withEmpty = signParams({ a: 1, b: '', c: null, d: undefined }, 's');
    const without = signParams({ a: 1 }, 's');
    assert.equal(withEmpty, without);
  });

  it('changes when any signed parameter changes', () => {
    const base = signParams({ folder: 'a', timestamp: 1 }, 's');
    assert.notEqual(base, signParams({ folder: 'b', timestamp: 1 }, 's'));
    assert.notEqual(base, signParams({ folder: 'a', timestamp: 2 }, 's'));
  });
});

describe('buildUploadSignature', () => {
  it('scopes identified uploads to the owner folder', () => {
    const sig = buildUploadSignature({ kind: 'ticket', ownerId: 'user-42' });
    assert.ok(sig.folder.includes('u/user-42'), sig.folder);
    assert.ok(sig.folder.startsWith('abuad-src-portal/tickets/'), sig.folder);
  });

  it('never puts the user id in an anonymous upload path', () => {
    // This is the anonymity guarantee: a public-read URL containing the
    // author's id would deanonymise an anonymous ticket.
    const sig = buildUploadSignature({ kind: 'ticket', ownerId: null });
    assert.ok(!sig.folder.includes('u/'), sig.folder);
    assert.ok(sig.folder.includes('/anon/'), sig.folder);
  });

  it('gives every anonymous upload a distinct folder', () => {
    // Shared folders would let attachments of different anonymous tickets
    // be correlated with each other.
    const a = buildUploadSignature({ ownerId: null }).folder;
    const b = buildUploadSignature({ ownerId: null }).folder;
    assert.notEqual(a, b);
  });

  it('constrains format and size in the signed parameters', () => {
    const sig = buildUploadSignature({ ownerId: 'u1' });
    assert.deepEqual(sig.allowedFormats, ALLOWED_FORMATS);
    assert.equal(sig.maxBytes, MAX_FILE_BYTES);
  });

  it('strips image metadata, so GPS data cannot leak', () => {
    const sig = buildUploadSignature({ ownerId: 'u1' });
    assert.match(sig.transformation, /fl_strip_profile/);
  });

  it('never returns the API secret', () => {
    const sig = buildUploadSignature({ ownerId: 'u1' });
    const serialised = JSON.stringify(sig);
    assert.ok(!serialised.includes('test-secret'), 'API secret leaked to client payload');
  });

  it('rejects an unknown upload kind', () => {
    assert.throws(() => buildUploadSignature({ kind: 'evil', ownerId: 'u1' }));
  });
});

describe('isPublicIdWithinFolder', () => {
  const folder = 'abuad-src-portal/tickets/u/user-1';

  it('accepts a direct child of the authorised folder', () => {
    assert.equal(isPublicIdWithinFolder(`${folder}/abc-123`, folder), true);
  });

  it("rejects another user's folder", () => {
    // The IDOR case: claiming a public_id belonging to someone else would
    // attach their image to this user's ticket.
    const other = 'abuad-src-portal/tickets/u/user-2/abc';
    assert.equal(isPublicIdWithinFolder(other, folder), false);
  });

  it('rejects path traversal', () => {
    assert.equal(isPublicIdWithinFolder(`${folder}/../../secret`, folder), false);
  });

  it('rejects a nested path', () => {
    assert.equal(isPublicIdWithinFolder(`${folder}/a/b`, folder), false);
  });

  it('rejects a prefix collision', () => {
    // 'u/user-11' starts with 'u/user-1' as a string but is a different
    // user — the reason the check requires a trailing separator.
    const sibling = 'abuad-src-portal/tickets/u/user-11/abc';
    assert.equal(isPublicIdWithinFolder(sibling, folder), false);
  });

  it('rejects empty and non-string input', () => {
    assert.equal(isPublicIdWithinFolder('', folder), false);
    assert.equal(isPublicIdWithinFolder(null, folder), false);
    assert.equal(isPublicIdWithinFolder(undefined, undefined), false);
    assert.equal(isPublicIdWithinFolder(123, folder), false);
  });
});

describe('buildDeliveryUrl', () => {
  it('builds a delivery URL with automatic format and a width cap', () => {
    const url = buildDeliveryUrl('folder/abc');
    assert.match(url, /^https:\/\/res\.cloudinary\.com\/test-cloud\/image\/upload\//);
    assert.match(url, /f_auto/);
    assert.match(url, /w_1600/);
    assert.ok(url.endsWith('/folder/abc'));
  });

  it('builds a square crop for thumbnails', () => {
    const url = buildDeliveryUrl('folder/abc', { thumb: true });
    assert.match(url, /c_fill,w_320,h_320/);
  });

  it('returns null rather than a broken URL when there is no id', () => {
    assert.equal(buildDeliveryUrl(null), null);
    assert.equal(buildDeliveryUrl(''), null);
  });
});
