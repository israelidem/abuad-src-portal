/**
 * Generates the PWA icon set from the SRC logo.
 *
 * Run with `npm run icons` after replacing src/assets/src-logo.png.
 * Output is committed, so a normal build/deploy never needs sharp.
 *
 * Two shapes are produced:
 *   - "any"     — the logo on a white square, edge to edge.
 *   - "maskable" — the same logo inset to ~62% of the canvas. Android
 *     crops maskable icons to a circle/squircle, so a full-bleed logo
 *     loses its edges. The padding is the safe zone the spec asks for.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, '../src/assets/src-logo.png');
const OUT_DIR = resolve(here, '../public/icons');

// ABUAD green — matches theme_color so the icon doesn't sit on a
// mismatched background during the splash screen.
const BACKGROUND = { r: 255, g: 255, b: 255, alpha: 1 };

const SIZES = [64, 192, 512];

async function render(size, { maskable }) {
  // Maskable icons keep the logo inside the 80% safe zone; a little
  // tighter here so the wordmark survives an aggressive circle crop.
  const logoSize = maskable ? Math.round(size * 0.62) : size;
  const pad = Math.round((size - logoSize) / 2);

  const logo = await sharp(SOURCE)
    .resize(logoSize, logoSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();

  const name = maskable ? `maskable-${size}.png` : `icon-${size}.png`;

  await sharp({
    create: { width: size, height: size, channels: 4, background: BACKGROUND },
  })
    .composite([{ input: logo, top: pad, left: pad }])
    .png()
    .toFile(resolve(OUT_DIR, name));

  return name;
}

await mkdir(OUT_DIR, { recursive: true });

const written = [];
for (const size of SIZES) {
  written.push(await render(size, { maskable: false }));
}
for (const size of [192, 512]) {
  written.push(await render(size, { maskable: true }));
}

// Apple ignores the manifest and reads apple-touch-icon, which must not
// have transparency — hence the white background above.
console.log(`Wrote ${written.length} icons to public/icons:\n  ${written.join('\n  ')}`);
