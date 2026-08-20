/**
 * Obfuscation-tolerant text moderation.
 *
 * Pure functions only — no database, no Express, no I/O. That keeps the
 * matcher unit-testable without a Supabase project (the rest of this
 * codebase's tests follow the same rule) and means it can be called from a
 * request path without a round-trip.
 *
 * ## Why not `body.includes('fuck')`
 *
 * Exact matching fails on everything people actually type:
 *
 *   FUCK        capitalisation
 *   f.u.c.k     punctuation between letters
 *   fuuuuck     repeated characters
 *   f u c k      spaces between characters
 *   fvck / f*ck  substitution and deletion
 *   ƒüçk        Unicode lookalikes
 *
 * …while *over*-matching on words that merely contain the sequence:
 * "classic", "assessment", "Scunthorpe", "cockroach", "therapist".
 *
 * So this module does three things in order:
 *
 *   1. **Normalise** — Unicode-fold, strip diacritics, drop zero-width
 *      characters, lowercase, collapse absurd character runs.
 *   2. **Mask the allowlist** — legitimate words are blanked out *before*
 *      any prohibited term is looked for, so "assessment" can never
 *      contribute to a match.
 *   3. **Match with a tolerant pattern** — each term becomes a bounded
 *      regex that accepts substitutions, repeats and separators between
 *      letters, anchored so it only fires on word boundaries.
 *
 * ## Safety of the generated patterns
 *
 * Every quantifier is bounded (`{1,3}`, `{0,3}`) rather than `+`/`*`. Some
 * characters are legal both as a separator and as a letter substitute
 * (`*`, `#`, `!`, `|`), and with unbounded quantifiers that overlap is a
 * classic catastrophic-backtracking shape — an attacker could hang the
 * request thread with a comment made of asterisks. Bounded quantifiers make
 * the worst case linear-ish and are more than enough: nobody bypasses a
 * filter with four consecutive separators.
 */

/** Comments are capped at 2000 chars by Zod; scan a little past that. */
const MAX_SCAN_LENGTH = 8000;

/**
 * Characters that may appear *between* the letters of an obfuscated word.
 *
 * Deliberately excludes letters and digits: that exclusion is what stops
 * "fantastic urgent cafeteria kitchen" from matching f-u-c-k.
 */
const SEPARATOR = String.raw`[^\p{L}\p{N}]`;

/**
 * What each letter can be written as.
 *
 * Read as "if the term has an `a`, accept any of these". The vowel classes
 * include `*` and `#` because deletion-style masking ("f*ck", "sh#t")
 * replaces the vowel rather than adding to it.
 */
const LETTER_CLASSES = {
  a: 'a@4^*#',
  b: 'b86',
  c: 'ck(<{[¢',
  d: 'd',
  e: 'e3€*#',
  f: 'f',
  g: 'g9',
  h: 'h',
  i: 'i1!|l¡*#',
  j: 'j',
  k: 'kc',
  l: 'l1|i',
  m: 'm',
  n: 'nñ',
  o: 'o0()*#',
  p: 'p',
  q: 'q',
  r: 'r',
  s: 's5$z',
  t: 't7+',
  u: 'uv*#',
  v: 'vu',
  w: 'w',
  x: 'x',
  y: 'y¥',
  z: 'zs2',
};

/**
 * Reverse index: which canonical letters could this character represent?
 *
 * Used only for the cheap prefilter below. Multi-valued on purpose — `1`
 * could be `i` or `l`, and a prefilter that guessed wrong would drop a real
 * match.
 */
const CHAR_TO_LETTERS = new Map();
for (const [letter, chars] of Object.entries(LETTER_CLASSES)) {
  for (const ch of chars) {
    if (!CHAR_TO_LETTERS.has(ch)) CHAR_TO_LETTERS.set(ch, new Set());
    CHAR_TO_LETTERS.get(ch).add(letter);
  }
}

/** Zero-width and bidi characters — invisible, and a trivial bypass. */
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/**
 * Normalises text for matching.
 *
 * Returns a string of the **same length** as the input wherever possible so
 * that match offsets can be mapped back to the original text for the
 * evidence snippet a moderator sees. The one length-changing step (run
 * collapsing) is applied separately, in `collapseRuns`, and is not used for
 * offset-sensitive work.
 */
export const normaliseForMatching = (input) => {
  if (typeof input !== 'string' || input.length === 0) return '';

  return (
    input
      .slice(0, MAX_SCAN_LENGTH)
      // NFKD splits "é" into "e" + combining accent, and folds compatibility
      // forms such as fullwidth "ｆｕｃｋ" onto ASCII.
      .normalize('NFKD')
      // Combining marks removed — "fúçk" and "fuck" must not differ.
      .replace(/\p{M}/gu, '')
      .replace(INVISIBLE, '')
      .toLowerCase()
  );
};

/**
 * Collapses runs of 3 or more identical characters down to two.
 *
 * Two, not one: "fuuuuuuck" becomes "fuuck" which the `{1,3}` letter
 * quantifier still matches, while genuine doubles ("committee",
 * "assessment") are left untouched so the allowlist can still recognise
 * them.
 */
export const collapseRuns = (text) => text.replace(/(.)\1{2,}/gu, '$1$1');

/** Escapes a string for literal use inside a character class or pattern. */
const escapeForClass = (s) => s.replace(/[\\\]^-]/g, '\\$&');

/**
 * Compiles one term into a tolerant, anchored regex.
 *
 * Letters become `[class]{1,3}`; spaces in a phrase become "any number of
 * separators, or none" so "sex for grades" also catches "sexforgrades";
 * everything else is matched literally.
 *
 * Each letter unit also tolerates *separated* repeats —
 * `(?:SEP{1,3}[class]{1,3}){0,2}` — which is what catches "F.U.U.C.K".
 * Run-collapsing alone cannot: it only sees adjacent duplicates, and here
 * the duplicated `u` has a full stop between the two copies. The inner
 * separator is `{1,3}` rather than `{0,3}` deliberately, so it can never
 * match empty and duplicate what the outer `[class]{1,3}` already does —
 * that overlap is what turns a bounded pattern into a backtracking one.
 *
 * The lookarounds are the anti-Scunthorpe guard: the match may not be
 * preceded or followed by a letter or digit, so "ass" cannot fire inside
 * "class" or "assessment" — no allowlist entry required.
 */
const compilePattern = (term) => {
  const chars = [...term];
  const parts = [];

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];

    if (ch === ' ') {
      // Word gap inside a phrase: optional, and may be any separator run.
      parts.push(`${SEPARATOR}{0,4}`);
      continue;
    }

    const klass = LETTER_CLASSES[ch];

    if (klass) {
      const cls = `[${escapeForClass(klass)}]{1,3}`;
      parts.push(`${cls}(?:${SEPARATOR}{1,3}${cls}){0,2}`);
    } else {
      parts.push(escapeForClass(ch));
    }

    // Allow separators between letters, but only between letters — not
    // after the final one, or the match would swallow trailing punctuation
    // and the boundary lookahead would misjudge it.
    const next = chars[i + 1];
    if (next !== undefined && next !== ' ') parts.push(`${SEPARATOR}{0,3}`);
  }


  return new RegExp(
    `(?<![\\p{L}\\p{N}])${parts.join('')}(?![\\p{L}\\p{N}])`,
    'gu'
  );
};

/**
 * Compiled-pattern cache.
 *
 * Terms are stable (a built-in list plus a slow-changing admin list), so
 * compiling each one once per process turns pattern building from a
 * per-request cost into a one-off. Bounded so a compromised or careless
 * admin adding thousands of terms cannot grow it without limit.
 */
const patternCache = new Map();
const PATTERN_CACHE_LIMIT = 2000;

const patternFor = (term) => {
  const cached = patternCache.get(term);
  if (cached) return cached;

  const pattern = compilePattern(term);
  if (patternCache.size < PATTERN_CACHE_LIMIT) patternCache.set(term, pattern);
  return pattern;
};

/** Exposed for tests and diagnostics. */
export const _patternCacheSize = () => patternCache.size;

/**
 * The set of canonical letters the text *could* contain.
 *
 * A term whose first letter isn't in this set cannot possibly match, so its
 * regex is never run. With a few hundred terms this skips the large
 * majority of scans on a typical comment. Multi-valued mapping keeps it
 * sound — it never rejects a term that would have matched.
 */
const possibleLetters = (text) => {
  const set = new Set();
  for (const ch of text) {
    if (ch >= 'a' && ch <= 'z') {
      set.add(ch);
      continue;
    }
    const mapped = CHAR_TO_LETTERS.get(ch);
    if (mapped) for (const l of mapped) set.add(l);
  }
  return set;
};

/**
 * Blanks out allowlisted words so they cannot contribute to a match.
 *
 * Replacement is `x` repeated to the same length: same offsets, and `x`
 * appears in no prohibited term and in no substitution class, so the mask
 * can't accidentally form a new match at the seam.
 */
const maskAllowlist = (text, allowlist) => {
  let masked = text;

  for (const word of allowlist) {
    if (!word) continue;
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
      'gu'
    );
    masked = masked.replace(pattern, (m) => 'x'.repeat(m.length));
  }

  return masked;
};

const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };

/**
 * Number of `low` severity hits needed before a comment is flagged.
 *
 * One "damn" or "stupid" in a complaint about a broken toilet is not a
 * moderation case, and flagging it would bury the queue in noise until
 * moderators stopped reading it. Two or more suggests a pattern.
 */
export const LOW_SEVERITY_THRESHOLD = 2;

/**
 * Runs the moderation check.
 *
 * @param text       Raw user input.
 * @param options.terms      `[{ term, category, severity }]` — built-in plus
 *                           admin-managed, already merged and filtered to
 *                           enabled entries by the caller.
 * @param options.allowlist  Words that must never be flagged.
 *
 * @returns
 *   flagged     whether a moderator should look at this
 *   severity    highest severity seen ('low' | 'medium' | 'high' | null)
 *   hidden      whether it should be withheld from the public thread while
 *               it waits for review
 *   matches     `[{ term, category, severity, snippet }]` — evidence
 *   categories  distinct categories hit, for filtering the queue
 *   reason      one-line summary written for a moderator to read
 */
export const analyseText = (text, { terms = [], allowlist = [] } = {}) => {
  const empty = {
    flagged: false,
    severity: null,
    hidden: false,
    matches: [],
    categories: [],
    reason: null,
  };

  if (typeof text !== 'string' || text.trim().length === 0) return empty;

  const normalised = collapseRuns(normaliseForMatching(text));
  if (!normalised) return empty;

  const haystack = maskAllowlist(normalised, allowlist);
  const available = possibleLetters(haystack);

  const matches = [];
  const seen = new Set();

  for (const entry of terms) {
    const term = typeof entry === 'string' ? entry : entry?.term;
    if (!term) continue;

    const canonical = term.toLowerCase().trim();
    if (!canonical) continue;

    // Cheap reject: first letter of the term can't be represented anywhere
    // in the text, so the pattern cannot match.
    const first = canonical[0];
    if (LETTER_CLASSES[first] && !available.has(first)) continue;

    const pattern = patternFor(canonical);
    pattern.lastIndex = 0;
    const found = pattern.exec(haystack);
    if (!found) continue;

    // One row per term, but keep the *count*. Saying "bitch" four times is
    // not the same case as saying it once, and collapsing that to a single
    // hit let repeated low-severity abuse ("sh1t sh1t sh1t") stay under the
    // threshold — the exact thing the threshold exists to catch.
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    pattern.lastIndex = 0;
    let occurrences = 0;
    while (pattern.exec(haystack) !== null) {
      occurrences += 1;
      // Guard against a zero-width match looping forever, and against a
      // 2000-character comment of one repeated word costing more than it
      // is worth to count precisely.
      if (occurrences >= 25) break;
    }

    matches.push({
      term: canonical,
      category: (typeof entry === 'object' && entry.category) || 'PROFANITY',
      severity: (typeof entry === 'object' && entry.severity) || 'medium',
      occurrences,
      // Snippet comes from the *normalised* text, not the raw input. The
      // raw substring would be more faithful, but run-collapsing shifts
      // offsets, and showing a moderator a mis-sliced quote is worse than
      // showing them the normalised form.
      snippet: found[0].slice(0, 60),
    });
  }


  if (matches.length === 0) return empty;

  const highest = matches.reduce(
    (acc, m) => (SEVERITY_RANK[m.severity] > SEVERITY_RANK[acc] ? m.severity : acc),
    'low'
  );

  // Counts occurrences, not distinct terms — see the note in the loop.
  const lowCount = matches
    .filter((m) => m.severity === 'low')
    .reduce((sum, m) => sum + (m.occurrences ?? 1), 0);

  // A single low-severity hit is noise, not a case.
  const flagged =
    highest !== 'low' || lowCount >= LOW_SEVERITY_THRESHOLD;


  if (!flagged) return { ...empty, matches };

  const categories = [...new Set(matches.map((m) => m.category))];

  /**
   * Self-harm content is flagged but never hidden.
   *
   * Hiding it would take a student's cry for help off the thread where
   * someone might answer it, which is the opposite of what the flag is for.
   */
  const selfHarmOnly = categories.length === 1 && categories[0] === 'SELF_HARM';

  return {
    flagged: true,
    severity: highest,
    hidden: highest === 'high' && !selfHarmOnly,
    matches,
    categories,
    reason: buildReason(matches, highest),
  };
};

/**
 * Writes the sentence a moderator reads in the queue.
 *
 * Includes the matched terms because "flagged as profanity" doesn't tell a
 * moderator whether the filter was right, and they need to decide that in
 * seconds.
 */
const buildReason = (matches, severity) => {
  const cats = [...new Set(matches.map((m) => m.category))].join(', ');
  const terms = matches.map((m) => m.term).slice(0, 6).join(', ');
  const more = matches.length > 6 ? ` (+${matches.length - 6} more)` : '';

  return `Automatic filter: ${cats} — matched ${terms}${more} [severity ${severity}]`;
};
