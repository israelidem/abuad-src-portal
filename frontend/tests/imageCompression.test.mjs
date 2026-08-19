/**
 * Tests for the compression decision logic.
 *
 * `compressImage` itself needs a canvas and cannot run under plain Node,
 * which is exactly why the geometry and the skip policy were extracted as
 * pure functions — those are where the off-by-one and the
 * "we made the file bigger" mistakes live, and they are testable here.
 *
 * Run: node --test tests/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fitWithin,
  shouldCompress,
  MAX_DIMENSION,
  SKIP_COMPRESSION_BELOW,
  COMPRESSIBLE_TYPES,
} from '../src/lib/imageCompression.js';

const file = (type, size, name = 'x') => ({ type, size, name });

test('fitWithin', async (t) => {
  await t.test('leaves images already within bounds untouched', () => {
    const r = fitWithin(800, 600);
    assert.deepEqual(r, { width: 800, height: 600, scaled: false });
  });

  await t.test('treats an exactly-max image as needing no work', () => {
    // The boundary: 1600 is allowed, so it must not be rescaled to 1600
    // via a pointless re-encode.
    const r = fitWithin(MAX_DIMENSION, MAX_DIMENSION);
    assert.equal(r.scaled, false);
  });

  await t.test('scales a landscape photo by its long edge', () => {
    // 4000x3000 (a typical phone camera) → 1600x1200
    const r = fitWithin(4000, 3000);
    assert.equal(r.width, 1600);
    assert.equal(r.height, 1200);
    assert.equal(r.scaled, true);
  });

  await t.test('scales a portrait photo by its long edge', () => {
    // The bug this guards: using max/width unconditionally would leave a
    // portrait image 1600 wide and 2133 tall — still over the cap.
    const r = fitWithin(3000, 4000);
    assert.equal(r.height, 1600);
    assert.equal(r.width, 1200);
  });

  await t.test('never returns a dimension below 1', () => {
    // An extreme panorama: 20000x5 would round its short edge to 0, and a
    // zero-height canvas throws on drawImage.
    const r = fitWithin(20000, 5);
    assert.ok(r.height >= 1, `height was ${r.height}`);
    assert.ok(r.width <= MAX_DIMENSION);
  });

  await t.test('preserves aspect ratio within a pixel', () => {
    const r = fitWithin(4032, 3024);
    const before = 4032 / 3024;
    const after = r.width / r.height;
    assert.ok(Math.abs(before - after) < 0.01, `ratio drifted: ${before} vs ${after}`);
  });

  await t.test('honours a caller-supplied max', () => {
    const r = fitWithin(1000, 1000, 500);
    assert.equal(r.width, 500);
    assert.equal(r.height, 500);
  });
});

test('shouldCompress', async (t) => {
  await t.test('accepts large JPEGs — the common case', () => {
    assert.equal(shouldCompress(file('image/jpeg', 4 * 1024 * 1024)), true);
  });

  await t.test('skips files already small enough', () => {
    // Re-encoding these usually enlarges them.
    assert.equal(shouldCompress(file('image/jpeg', 50 * 1024)), false);
  });

  await t.test('treats the skip threshold as inclusive', () => {
    assert.equal(shouldCompress(file('image/jpeg', SKIP_COMPRESSION_BELOW)), false);
    assert.equal(shouldCompress(file('image/jpeg', SKIP_COMPRESSION_BELOW + 1)), true);
  });

  await t.test('skips HEIC, which most browsers cannot decode', () => {
    // Routing HEIC through canvas produces a blank image on Chrome and
    // Firefox — a silently white "photo" instead of the student's
    // evidence. It must pass through untouched.
    assert.equal(shouldCompress(file('image/heic', 5 * 1024 * 1024)), false);
    assert.ok(!COMPRESSIBLE_TYPES.includes('image/heic'));
  });

  await t.test('skips non-images', () => {
    assert.equal(shouldCompress(file('application/pdf', 9 * 1024 * 1024)), false);
    assert.equal(shouldCompress(file('image/gif', 9 * 1024 * 1024)), false);
  });

  await t.test('accepts PNG and WebP', () => {
    assert.equal(shouldCompress(file('image/png', 3 * 1024 * 1024)), true);
    assert.equal(shouldCompress(file('image/webp', 3 * 1024 * 1024)), true);
  });
});

test('a compressed phone photo lands under the upload cap', () => {
  // Not a compression test — an arithmetic sanity check on the settings.
  // A 4000x3000 photo becomes 1600x1200 = 1.92 MP. JPEG at q0.82
  // averages roughly 0.15–0.25 bytes/pixel for photographic content,
  // so ~290–480 KB: comfortably inside the 5 MB limit with room for
  // atypical images. If MAX_DIMENSION or the quality is raised much
  // beyond this, that headroom is what gets spent.
  const { width, height } = fitWithin(4000, 3000);
  const pixels = width * height;
  const pessimisticBytes = pixels * 0.35;

  assert.ok(
    pessimisticBytes < 5 * 1024 * 1024,
    `estimated ${Math.round(pessimisticBytes / 1024)} KB exceeds the cap`
  );
});
