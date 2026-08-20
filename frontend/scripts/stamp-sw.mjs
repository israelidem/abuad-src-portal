/**
 * Stamps a real cache version into the built service worker.
 *
 * `public/sw.js` ships a `__BUILD_VERSION__` placeholder. Vite copies
 * public/ verbatim — it does not substitute anything in there — so the
 * replacement has to happen on the build output, after `vite build`.
 * This script rewrites `dist/sw.js` and never touches the source.
 *
 * Why the version is derived from the asset filenames rather than a
 * timestamp or the git SHA:
 *
 *   - A timestamp changes on every build, including rebuilds that produce
 *     byte-identical output. Since the browser detects a new worker by
 *     diffing sw.js, that would prompt users to reload for a deploy that
 *     changed nothing.
 *   - The git SHA has the same problem (any commit, even backend-only or
 *     a README edit, would prompt a frontend reload) and isn't reliably
 *     available in every CI environment.
 *   - Vite's asset hashes are content-derived. Hashing the sorted list of
 *     them gives a value that changes when, and only when, the shipped
 *     frontend actually changes. Same output, same version, no prompt.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const swPath = join(dist, 'sw.js');
const PLACEHOLDER = '__BUILD_VERSION__';

/** Fail loudly. A silently unstamped worker never evicts its caches. */
function fail(message) {
  console.error(`stamp-sw: ${message}`);
  process.exit(1);
}

const source = await readFile(swPath, 'utf8').catch(() => {
  fail(`${swPath} not found — run \`vite build\` first.`);
});

if (!source.includes(PLACEHOLDER)) {
  fail(
    `${PLACEHOLDER} not found in dist/sw.js. If the placeholder in ` +
      'public/sw.js was renamed, update PLACEHOLDER here to match.'
  );
}

const assets = await readdir(join(dist, 'assets')).catch(() => {
  fail('dist/assets not found — build output looks incomplete.');
});

if (assets.length === 0) fail('dist/assets is empty — build output looks incomplete.');

// Sorted: readdir order is filesystem-dependent, and an unsorted list
// would hash differently across machines for identical output.
const version = createHash('sha256').update(assets.sort().join('\n')).digest('hex').slice(0, 12);

await writeFile(swPath, source.replaceAll(PLACEHOLDER, version));

console.log(`stamp-sw: cache version ${version} (${assets.length} assets)`);
