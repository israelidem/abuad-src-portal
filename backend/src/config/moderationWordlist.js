/**
 * Built-in moderation word list.
 *
 * This is the *seed* list. It ships with the code so a fresh deployment is
 * never unmoderated, but it is deliberately not the only source: admins add
 * their own terms through the moderation dashboard and those are read from
 * the database at request time (see services/moderationService.js), so a
 * new slur can be blocked without a deploy.
 *
 * Shape of an entry:
 *
 *   term      the word or phrase, in plain lowercase. Obfuscation is handled
 *             by the matcher, not by listing variants — do NOT add "fvck",
 *             "f*ck" or "fuuuck" here, they are already covered.
 *   category  what kind of problem it is. Drives the flag reason a moderator
 *             reads, and lets the queue be filtered.
 *   severity  'high'  — flag and hide from students pending review
 *             'medium'— flag for review, stays visible
 *             'low'   — flag only when several hits land in one comment
 *
 * Why severity exists: a comment calling a rep an idiot and a comment
 * threatening to stab a named student both need looking at, but only one of
 * them should disappear from the thread while it waits.
 *
 * Audience note: this is a Nigerian university student portal, so the list
 * covers English profanity plus the local slurs and threats that actually
 * turn up in student complaints. It is not exhaustive and is not meant to
 * be — that is what the admin-managed list is for.
 */

/**
 * Terms that are only a problem as whole words and are common substrings of
 * innocent words. The matcher already anchors on non-letter boundaries, so
 * these are listed for clarity rather than special handling.
 */
export const MODERATION_CATEGORIES = [
  'PROFANITY',
  'SEXUAL',
  'HATE',
  'THREAT',
  'HARASSMENT',
  'SELF_HARM',
  'SPAM',
];

/** Human-readable labels for the moderation queue. */
export const CATEGORY_LABELS = {
  PROFANITY: 'Profanity',
  SEXUAL: 'Sexual content',
  HATE: 'Hate speech',
  THREAT: 'Threat or violence',
  HARASSMENT: 'Harassment',
  SELF_HARM: 'Self-harm',
  SPAM: 'Spam',
};

const entry = (term, category, severity = 'medium') => ({ term, category, severity });

export const BUILTIN_WORDLIST = [
  // ---------- Profanity ----------
  entry('fuck', 'PROFANITY', 'medium'),
  entry('motherfucker', 'PROFANITY', 'high'),
  entry('fucker', 'PROFANITY', 'medium'),
  entry('shit', 'PROFANITY', 'low'),
  entry('bullshit', 'PROFANITY', 'low'),
  entry('bitch', 'PROFANITY', 'medium'),
  entry('bastard', 'PROFANITY', 'medium'),
  entry('asshole', 'PROFANITY', 'medium'),
  entry('arsehole', 'PROFANITY', 'medium'),
  entry('dickhead', 'PROFANITY', 'medium'),
  entry('prick', 'PROFANITY', 'low'),
  entry('wanker', 'PROFANITY', 'medium'),
  entry('twat', 'PROFANITY', 'medium'),
  entry('cunt', 'PROFANITY', 'high'),
  entry('bollocks', 'PROFANITY', 'low'),
  entry('crap', 'PROFANITY', 'low'),
  entry('damn', 'PROFANITY', 'low'),
  entry('goddamn', 'PROFANITY', 'low'),
  entry('piss off', 'PROFANITY', 'low'),
  entry('son of a bitch', 'PROFANITY', 'medium'),

  // Local / Nigerian-English insults that show up in student complaints.
  entry('mumu', 'HARASSMENT', 'low'),
  entry('ode', 'HARASSMENT', 'low'),
  entry('olodo', 'HARASSMENT', 'low'),
  entry('werey', 'HARASSMENT', 'low'),
  entry('mad o', 'HARASSMENT', 'low'),
  entry('yeye', 'HARASSMENT', 'low'),
  entry('ashawo', 'SEXUAL', 'medium'),
  entry('olosho', 'SEXUAL', 'medium'),
  entry('ashewo', 'SEXUAL', 'medium'),

  // ---------- Sexual content ----------
  entry('pussy', 'SEXUAL', 'medium'),
  entry('dick', 'SEXUAL', 'low'),
  entry('cock', 'SEXUAL', 'low'),
  entry('penis', 'SEXUAL', 'low'),
  entry('vagina', 'SEXUAL', 'low'),
  entry('blowjob', 'SEXUAL', 'high'),
  entry('handjob', 'SEXUAL', 'high'),
  entry('cum', 'SEXUAL', 'medium'),
  entry('jerk off', 'SEXUAL', 'medium'),
  entry('porn', 'SEXUAL', 'medium'),
  entry('pornhub', 'SEXUAL', 'medium'),
  entry('nudes', 'SEXUAL', 'medium'),
  entry('send nudes', 'SEXUAL', 'high'),
  entry('horny', 'SEXUAL', 'low'),
  entry('slut', 'SEXUAL', 'high'),
  entry('whore', 'SEXUAL', 'high'),
  entry('rape', 'SEXUAL', 'high'),
  entry('rapist', 'SEXUAL', 'high'),
  entry('molest', 'SEXUAL', 'high'),
  entry('paedophile', 'SEXUAL', 'high'),
  entry('pedophile', 'SEXUAL', 'high'),
  entry('sex for grades', 'SEXUAL', 'high'),

  // ---------- Hate speech ----------
  // Ethnic and religious slurs. Kept short deliberately: the matcher
  // handles spacing and substitution, so one canonical spelling is enough.
  entry('nigger', 'HATE', 'high'),
  entry('nigga', 'HATE', 'high'),
  entry('faggot', 'HATE', 'high'),
  entry('fag', 'HATE', 'high'),
  entry('dyke', 'HATE', 'high'),
  entry('tranny', 'HATE', 'high'),
  entry('retard', 'HATE', 'high'),
  entry('retarded', 'HATE', 'high'),
  entry('spastic', 'HATE', 'medium'),
  entry('kike', 'HATE', 'high'),
  entry('chink', 'HATE', 'high'),
  entry('coon', 'HATE', 'high'),
  entry('gypsy scum', 'HATE', 'high'),
  entry('infidel scum', 'HATE', 'high'),
  // Regional slurs relevant to a Nigerian campus.
  entry('aboki', 'HATE', 'medium'),
  entry('nyamiri', 'HATE', 'high'),
  entry('gambari', 'HATE', 'medium'),
  entry('ngbati', 'HATE', 'medium'),
  entry('kobokobo', 'HATE', 'medium'),
  entry('malo', 'HATE', 'low'),

  // ---------- Threats and violence ----------
  entry('i will kill you', 'THREAT', 'high'),
  entry('i will kill him', 'THREAT', 'high'),
  entry('i will kill her', 'THREAT', 'high'),
  entry('kill yourself', 'THREAT', 'high'),
  entry('kys', 'THREAT', 'high'),
  entry('i will beat you', 'THREAT', 'high'),
  entry('i will deal with you', 'THREAT', 'medium'),
  entry('i will stab', 'THREAT', 'high'),
  entry('i will shoot', 'THREAT', 'high'),
  entry('i will burn', 'THREAT', 'high'),
  entry('watch your back', 'THREAT', 'medium'),
  entry('you are dead', 'THREAT', 'high'),
  entry('death threat', 'THREAT', 'medium'),
  entry('bomb the', 'THREAT', 'high'),
  entry('shoot up', 'THREAT', 'high'),
  entry('lynch', 'THREAT', 'high'),
  entry('acid attack', 'THREAT', 'high'),
  entry('kidnap', 'THREAT', 'medium'),
  entry('cultist', 'THREAT', 'medium'),
  entry('jungle justice', 'THREAT', 'medium'),

  // ---------- Harassment ----------
  entry('idiot', 'HARASSMENT', 'low'),
  entry('stupid', 'HARASSMENT', 'low'),
  entry('moron', 'HARASSMENT', 'low'),
  entry('imbecile', 'HARASSMENT', 'low'),
  entry('useless fool', 'HARASSMENT', 'medium'),
  entry('shut up', 'HARASSMENT', 'low'),
  entry('nobody likes you', 'HARASSMENT', 'medium'),
  entry('go and die', 'HARASSMENT', 'high'),
  entry('you are worthless', 'HARASSMENT', 'medium'),
  entry('ugly ass', 'HARASSMENT', 'medium'),
  entry('fat pig', 'HARASSMENT', 'medium'),

  // ---------- Self-harm ----------
  // Flagged so a human sees it quickly. Deliberately NOT hidden: a student
  // in crisis should not have their message vanish. Severity 'medium'
  // keeps it visible while putting it at the top of the queue.
  entry('i want to die', 'SELF_HARM', 'medium'),
  entry('i will kill myself', 'SELF_HARM', 'medium'),
  entry('commit suicide', 'SELF_HARM', 'medium'),
  entry('end my life', 'SELF_HARM', 'medium'),
  entry('cut myself', 'SELF_HARM', 'medium'),

  // ---------- Spam ----------
  entry('click this link', 'SPAM', 'low'),
  entry('make money fast', 'SPAM', 'low'),
  entry('forex signals', 'SPAM', 'low'),
  entry('crypto giveaway', 'SPAM', 'low'),
  entry('whatsapp me on', 'SPAM', 'low'),
  entry('dm me for', 'SPAM', 'low'),
  entry('binary options', 'SPAM', 'low'),
  entry('sports betting tips', 'SPAM', 'low'),
];

/**
 * Words that must never be flagged even though a naive filter would catch
 * them. These are checked *before* the term patterns, and any span they
 * cover is masked out of the text.
 *
 * The matcher's word-boundary anchoring already prevents the classic
 * "Scunthorpe problem" ("class" containing a slur, "assassin" containing
 * "ass"), so this list is for the harder cases: legitimate words that are a
 * prohibited term *plus* letters, where the boundary check alone would not
 * help, and academic vocabulary a university portal genuinely needs.
 */
export const ALLOWLIST = [
  // Anatomy / medicine — a welfare complaint about a clinic needs these.
  'analysis',
  'analyse',
  'analyze',
  'analytical',
  'assessment',
  'assess',
  'assignment',
  'assist',
  'assistant',
  'assume',
  'assumption',
  'association',
  'assembly',
  'classic',
  'classification',
  'grass',
  'pass',
  'passed',
  'password',
  'bypass',
  'brass',
  'glass',
  'mass',
  'massive',
  'compass',
  'embassy',
  'harassment', // the word itself is not harassment
  'therapist',
  'specialist',
  'cockroach',
  'cocktail',
  'peacock',
  'shuttlecock',
  'titanium',
  'constitution',
  'substitute',
  'document',
  'documents',
  'scunthorpe',
  'penistone',
  'dickinson',
  'hancock',
  'cummings',
  'circumstance',
  'accumulate',
  'accumulation',
  'cucumber',
  'document',
  'sussex',
  'essex',
  'middlesex',
  'sexuality', // discussing policy is not sexual content
  'homosexual',
  'heterosexual',
  'unisex',
  'shitake',
  'shiitake',
  'crapaud',
  'therapeutic',
  'grape',
  'grapes',
  'drape',
  'scrape',
  'scrapes',
  'rapid',
  'rapidly',
  'rapport',
  'therapy',
  'trapeze',
  'killer feature',
  'skill',
  'skills',
  'skilled',
  'mackerel',
  'blackboard',
  'matriculation',
];
