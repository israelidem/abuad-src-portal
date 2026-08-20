/**
 * Comment moderation matcher — unit tests.
 *
 * Targets the pure matcher directly rather than going through HTTP, for the
 * same reason ticketVisibility.test.mjs does: this is where every flagging
 * decision is actually made, it needs no database, no Supabase project and
 * no seeded users, so the suite runs anywhere including CI without secrets.
 *
 * The cases are split into three groups, and all three matter equally:
 *
 *   1. Plain hits            — the filter works at all.
 *   2. Bypass attempts       — the filter is not defeated by typing tricks.
 *   3. False positives       — the filter does not flag legitimate words.
 *
 * Group 3 is the one that decides whether moderators keep using the queue.
 * A filter that flags "assessment" trains staff to click Approve without
 * reading, which is worse than no filter at all.
 *
 * Run with:  npm test          (from backend/)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyseText,
  normaliseForMatching,
  collapseRuns,
  LOW_SEVERITY_THRESHOLD,
} from '../src/lib/textModeration.js';
import { BUILTIN_WORDLIST, ALLOWLIST } from '../src/config/moderationWordlist.js';

/** Runs the real built-in list, exactly as the request path does. */
const check = (text) =>
  analyseText(text, { terms: BUILTIN_WORDLIST, allowlist: ALLOWLIST });

const flagged = (text) => check(text).flagged;

// ------------------------------------------------------------
// Normalisation
// ------------------------------------------------------------

describe('normalisation', () => {
  test('lowercases', () => {
    assert.equal(normaliseForMatching('ABUAD'), 'abuad');
  });

  test('strips diacritics so accented spellings do not slip through', () => {
    assert.equal(normaliseForMatching('fúçk'), 'fuck');
  });

  test('folds fullwidth characters onto ASCII', () => {
    assert.equal(normaliseForMatching('ｆｕｃｋ'), 'fuck');
  });

  test('removes zero-width characters used to break up words', () => {
    // A zero-width space between every letter is invisible in the UI but
    // defeats any naive substring check.
    assert.equal(normaliseForMatching('f\u200Bu\u200Bc\u200Bk'), 'fuck');
  });

  test('collapses long character runs but leaves genuine doubles alone', () => {
    assert.equal(collapseRuns('fuuuuuuck'), 'fuuck');
    assert.equal(collapseRuns('assessment'), 'assessment');
  });

  test('returns empty string for non-strings rather than throwing', () => {
    assert.equal(normaliseForMatching(null), '');
    assert.equal(normaliseForMatching(undefined), '');
    assert.equal(normaliseForMatching(42), '');
  });
});

// ------------------------------------------------------------
// 1. Plain hits
// ------------------------------------------------------------

describe('detects abuse in plain text', () => {
  test('profanity', () => {
    assert.ok(flagged('this is a fuck up'));
  });

  test('hate speech', () => {
    assert.ok(flagged('you are a faggot'));
  });

  test('threats', () => {
    assert.ok(flagged('I will kill you after the exam'));
  });

  test('sexual content', () => {
    assert.ok(flagged('the lecturer asked for sex for grades'));
  });

  test('reports which categories were hit', () => {
    const result = check('I will kill you, you faggot');
    assert.ok(result.categories.includes('THREAT'));
    assert.ok(result.categories.includes('HATE'));
  });

  test('records the matched terms as evidence for the moderator', () => {
    const result = check('you are a bastard');
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].term, 'bastard');
    assert.ok(result.reason.includes('bastard'));
  });

  test('clean text is not flagged', () => {
    assert.equal(
      flagged('The projector in LT2 has been broken for three weeks. Please fix it.'),
      false
    );
  });

  test('empty and whitespace input is not flagged', () => {
    assert.equal(flagged(''), false);
    assert.equal(flagged('   '), false);
    assert.equal(analyseText(null, { terms: BUILTIN_WORDLIST }).flagged, false);
  });
});

// ------------------------------------------------------------
// 2. Bypass attempts
//
// Each of these is a real technique. Every one of them defeats
// `body.toLowerCase().includes(word)`.
// ------------------------------------------------------------

describe('resists filter bypass', () => {
  test('capitalisation', () => {
    assert.ok(flagged('FUCK this portal'));
    assert.ok(flagged('FuCk this portal'));
  });

  test('punctuation between letters', () => {
    assert.ok(flagged('f.u.c.k this'));
    assert.ok(flagged('f-u-c-k this'));
    assert.ok(flagged('b_i_t_c_h'));
  });

  test('spaces between letters', () => {
    assert.ok(flagged('f u c k this place'));
  });

  test('repeated characters', () => {
    assert.ok(flagged('fuuuuuuck'));
    assert.ok(flagged('biiiitch'));
  });

  test('character substitution', () => {
    assert.ok(flagged('fvck'));
    assert.ok(flagged('sh1t sh1t')); // low severity, needs two
    assert.ok(flagged('b1tch'));
    assert.ok(flagged('n1gger'));
  });

  test('symbol masking', () => {
    assert.ok(flagged('f*ck'));
    assert.ok(flagged('f#ck'));
    assert.ok(flagged('a$$hole'));
  });

  test('leetspeak digits', () => {
    assert.ok(flagged('f4gg0t'));
  });

  test('mixed techniques at once', () => {
    // Capitalisation + substitution + separators + repeats together.
    assert.ok(flagged('F.U.U.C.K'));
    assert.ok(flagged('N I G G E R'));
  });

  test('phrases still match when the spaces are removed', () => {
    assert.ok(flagged('killyourself'));
  });

  test('zero-width characters', () => {
    assert.ok(flagged('f\u200Bu\u200Bc\u200Bk you'));
  });
});

// ------------------------------------------------------------
// 3. False positives — the Scunthorpe problem
// ------------------------------------------------------------

describe('does not flag legitimate words', () => {
  const legitimate = [
    'The assessment was graded unfairly.',
    'I need help with my assignment.',
    'Please pass this to the class representative.',
    'The classification of my course is wrong.',
    'My password reset link never arrived.',
    'There is a cockroach infestation in Hall 3.',
    'I would like to speak to a therapist at the clinic.',
    'The analysis of the results is incorrect.',
    'Documents were not submitted on time.',
    'Circumstances beyond my control.',
    'The grass outside the hostel needs cutting.',
    'I bought a cucumber from the cafeteria and it was rotten.',
    'The shuttlecock supply for badminton has run out.',
    'My matriculation number is not recognised.',
    'The lecturer has excellent skills.',
    'This is a massive problem for final year students.',
    'The student association should be informed.',
    'I want to discuss sexuality education policy.',
    'The glass in the window is cracked.',
    'Please assist me with course registration.',
  ];

  for (const text of legitimate) {
    test(`"${text.slice(0, 42)}…"`, () => {
      const result = check(text);
      assert.equal(
        result.flagged,
        false,
        `Unexpectedly flagged. Matched: ${JSON.stringify(result.matches)}`
      );
    });
  }
});

// ------------------------------------------------------------
// Severity behaviour
// ------------------------------------------------------------

describe('severity', () => {
  test('a single low-severity word is not a moderation case', () => {
    // Otherwise every mildly frustrated complaint lands in the queue and
    // moderators stop reading it.
    const result = check('this is a damn shame');
    assert.equal(result.flagged, false);
  });

  test(`${LOW_SEVERITY_THRESHOLD} low-severity words together are`, () => {
    const result = check('this damn stupid portal');
    assert.equal(result.flagged, true);
    assert.equal(result.severity, 'low');
  });

  test('high severity hides the comment pending review', () => {
    const result = check('you are a cunt');
    assert.equal(result.severity, 'high');
    assert.equal(result.hidden, true);
  });

  test('medium severity flags but leaves the comment visible', () => {
    const result = check('you bastard');
    assert.equal(result.severity, 'medium');
    assert.equal(result.hidden, false);
  });

  test('self-harm is flagged but never hidden', () => {
    // Hiding a cry for help takes it off the thread where someone might
    // answer it, which is the opposite of what the flag is for.
    const result = check('honestly I want to die');
    assert.equal(result.flagged, true);
    assert.equal(result.categories.join(), 'SELF_HARM');
    assert.equal(result.hidden, false);
  });
});

// ------------------------------------------------------------
// Admin-managed terms
// ------------------------------------------------------------

describe('admin-supplied terms', () => {
  test('a custom term is matched with the same obfuscation tolerance', () => {
    const terms = [{ term: 'zzquux', category: 'HARASSMENT', severity: 'high' }];

    assert.equal(analyseText('zzquux', { terms }).flagged, true);
    assert.equal(analyseText('Z.Z.Q.U.U.X', { terms }).flagged, true);
    assert.equal(analyseText('zzzquuux', { terms }).flagged, true);
    assert.equal(analyseText('something else', { terms }).flagged, false);
  });

  test('plain strings are accepted as well as objects', () => {
    assert.equal(analyseText('zzquux', { terms: ['zzquux'] }).flagged, true);
  });

  test('a disabled term is simply absent — caller filters, matcher trusts', () => {
    assert.equal(analyseText('zzquux', { terms: [] }).flagged, false);
  });

  test('a custom allowlist entry suppresses a match', () => {
    const terms = [{ term: 'quux', category: 'PROFANITY', severity: 'high' }];
    assert.equal(analyseText('quuxbar quux', { terms }).flagged, true);
    assert.equal(
      analyseText('quux', { terms, allowlist: ['quux'] }).flagged,
      false
    );
  });
});

// ------------------------------------------------------------
// Robustness
// ------------------------------------------------------------

describe('robustness', () => {
  test('pathological input does not hang the request thread', () => {
    // Separator characters double as letter substitutes, which is a
    // catastrophic-backtracking shape if the quantifiers are unbounded.
    // They are bounded; this asserts that stays true.
    const nasty = '*'.repeat(2000);
    const started = Date.now();
    analyseText(nasty, { terms: BUILTIN_WORDLIST, allowlist: ALLOWLIST });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 1000, `Took ${elapsed}ms — pattern is backtracking`);
  });

  test('a long clean comment is scanned quickly', () => {
    const text = 'The lecture hall projector is broken. '.repeat(50);
    const started = Date.now();
    analyseText(text, { terms: BUILTIN_WORDLIST, allowlist: ALLOWLIST });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 500, `Took ${elapsed}ms for a 1.8KB comment`);
  });

  test('input longer than the scan cap is truncated, not rejected', () => {
    const result = analyseText('a'.repeat(50_000), {
      terms: BUILTIN_WORDLIST,
      allowlist: ALLOWLIST,
    });
    assert.equal(result.flagged, false);
  });
});
