/**
 * One-off codemod: add `dark:` variants to light-only Tailwind classes.
 *
 * Dark mode was added late, so the pages written before it use hardcoded
 * light colours (`bg-white`, `text-slate-900`, `border-slate-200`). The
 * shell paints a dark background underneath, which left white cards and
 * dark-on-dark text — unreadable.
 *
 * Doing this by hand across ~30 files invites typos and missed spots, so
 * the mapping lives here instead. The transform is:
 *
 *   - Idempotent. A class only gains a variant if the matching `dark:`
 *     class isn't already on the same element, so re-running is safe and
 *     the pages that already had dark styling are untouched.
 *   - Scoped to class strings. Only `className="..."` and the template
 *     literals / ternaries inside them are rewritten, never arbitrary
 *     source text.
 *   - Opacity-aware. `bg-white/10` is a translucent overlay on the green
 *     header, not a surface colour, and must keep its light value.
 *
 * Run with: node scripts/add-dark-variants.mjs [--check]
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `.pathname`: this repo lives under a directory with
// a space in it ("Israel Idem"), which `.pathname` leaves percent-encoded
// as %20 and every fs call then fails with ENOENT.
const ROOT = fileURLToPath(new URL('../src', import.meta.url));

/**
 * base class -> dark variant to append.
 *
 * Surfaces step down (white -> slate-900), text steps up
 * (slate-900 -> white), and borders/dividers darken. The greens and
 * brand yellow are deliberately absent: they read fine on both themes.
 */
const MAP = {
  // Surfaces
  'bg-white': 'dark:bg-slate-900',
  'bg-slate-50': 'dark:bg-slate-900',
  'bg-slate-100': 'dark:bg-slate-800',
  'bg-slate-200': 'dark:bg-slate-700',

  // Text
  'text-slate-900': 'dark:text-white',
  'text-slate-800': 'dark:text-slate-100',
  'text-slate-700': 'dark:text-slate-300',
  'text-slate-600': 'dark:text-slate-400',
  'text-slate-500': 'dark:text-slate-400',
  'text-slate-400': 'dark:text-slate-500',
  'text-slate-300': 'dark:text-slate-600',

  // Borders & dividers
  'border-slate-200': 'dark:border-slate-800',
  'border-slate-300': 'dark:border-slate-700',
  'border-slate-100': 'dark:border-slate-800',
  'divide-slate-100': 'dark:divide-slate-800',
  'divide-slate-200': 'dark:divide-slate-800',

  // Tinted status surfaces — keep the hue, drop the lightness
  'bg-amber-50': 'dark:bg-amber-950/40',
  'bg-amber-100': 'dark:bg-amber-950',
  'bg-red-50': 'dark:bg-red-950/40',
  'bg-red-100': 'dark:bg-red-950',
  'bg-green-50': 'dark:bg-green-950/40',
  'bg-green-100': 'dark:bg-green-950',
  'bg-blue-50': 'dark:bg-blue-950/40',
  'bg-blue-100': 'dark:bg-blue-950',
  'bg-purple-100': 'dark:bg-purple-950',
  'text-amber-800': 'dark:text-amber-200',
  'text-amber-900': 'dark:text-amber-200',
  'text-red-600': 'dark:text-red-400',
  'text-red-700': 'dark:text-red-300',
  'text-red-800': 'dark:text-red-300',
  'text-green-600': 'dark:text-green-400',
  'text-green-800': 'dark:text-green-300',
  'text-blue-800': 'dark:text-blue-300',
  'text-purple-800': 'dark:text-purple-300',
  'border-amber-200': 'dark:border-amber-900/50',
  'border-red-200': 'dark:border-red-900/50',
  'border-green-200': 'dark:border-green-200/20',
  'border-blue-200': 'dark:border-blue-900/50',
  'border-purple-200': 'dark:border-purple-900/50',

  // Form controls
  'placeholder-slate-400': 'dark:placeholder-slate-500',
};

/** Prefixes that mean "this isn't a surface colour" — leave them alone. */
const SKIP_PREFIXES = ['focus:', 'hover:', 'active:', 'group-hover:', 'peer-', 'dark:'];

/**
 * Rewrites one whitespace-separated class list.
 *
 * Tokens are handled individually so a modifier like `hover:bg-white`
 * can't be mistaken for a bare `bg-white`, and `bg-white/10` — which
 * carries an opacity — is skipped entirely.
 */
function transformClassList(value) {
  const tokens = value.split(/(\s+)/); // capture separators to preserve formatting
  const present = new Set(tokens.map((t) => t.trim()).filter(Boolean));
  const additions = [];

  for (const token of tokens) {
    const cls = token.trim();
    if (!cls) continue;
    if (SKIP_PREFIXES.some((p) => cls.startsWith(p))) continue;
    if (cls.includes('/')) continue; // opacity modifier, e.g. bg-white/10

    const variant = MAP[cls];
    if (!variant) continue;
    if (present.has(variant)) continue; // already handled

    // Don't fight an existing decision: if any dark: class of the same
    // property is on this element, assume it was styled intentionally.
    const property = variant.slice('dark:'.length).replace(/-.*$/, '');
    const hasSameProperty = [...present].some(
      (p) => p.startsWith('dark:') && p.slice('dark:'.length).startsWith(`${property}-`)
    );
    if (hasSameProperty) continue;

    additions.push(variant);
    present.add(variant);
  }

  if (additions.length === 0) return null;
  return `${value.trimEnd()} ${additions.join(' ')}`;
}

/** Rewrites every className="..." / className={`...`} in a file. */
function transformSource(source) {
  let count = 0;

  // Plain string attributes: className="a b c"
  let out = source.replace(/className="([^"]*)"/g, (match, value) => {
    const next = transformClassList(value);
    if (!next) return match;
    count += 1;
    return `className="${next}"`;
  });

  // Template literals and ternaries: the static chunks between ${...}
  // are ordinary class lists, so each is transformed independently.
  out = out.replace(/`([^`]*)`/g, (match, inner) => {
    if (!/\b(bg|text|border|divide|placeholder)-/.test(inner)) return match;

    const rebuilt = inner.replace(/(^|\})([^${}]+)(?=\$\{|$)/g, (seg, lead, body) => {
      // Only touch segments that look like class lists
      if (!/[a-z]-\d|bg-white|text-white/.test(body)) return seg;
      const next = transformClassList(body);
      if (!next) return seg;
      count += 1;
      return `${lead}${next}`;
    });

    return `\`${rebuilt}\``;
  });

  // Quoted class strings inside style maps (constants.js badge tables)
  out = out.replace(/className: '([^']*)'/g, (match, value) => {
    const next = transformClassList(value);
    if (!next) return match;
    count += 1;
    return `className: '${next}'`;
  });

  return { out, count };
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (['.jsx', '.js'].includes(extname(entry))) files.push(full);
  }
  return files;
}

const checkOnly = process.argv.includes('--check');
let changedFiles = 0;
let totalEdits = 0;

for (const file of walk(ROOT)) {
  const source = readFileSync(file, 'utf8');
  const { out, count } = transformSource(source);

  if (count > 0 && out !== source) {
    changedFiles += 1;
    totalEdits += count;
    if (!checkOnly) writeFileSync(file, out, 'utf8');
    console.log(`  ${relative(ROOT, file)} — ${count} class list(s)`);
  }
}

console.log(
  `\n${checkOnly ? 'Would update' : 'Updated'} ${changedFiles} file(s), ${totalEdits} class list(s).`
);
