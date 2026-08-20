/**
 * Structured logging.
 *
 * The audit called observability weak, and it was: ten scattered
 * `console.log` calls with inconsistent prefixes, no request correlation,
 * and no way to tell which student's request produced a 500. When a report
 * comes in as "the portal was broken this afternoon", there was nothing to
 * search.
 *
 * Design notes, because a few choices here are deliberate:
 *
 *   - **JSON in production, prose in development.** Render and Vercel both
 *     ingest JSON lines and let you query fields; a human reading a local
 *     terminal wants none of that. Same call site, two renderings.
 *
 *   - **No logging library.** Pino or Winston would be the reflex, but this
 *     needs one file's worth of behaviour and the brief says not to add
 *     unnecessary dependencies. Every log line already goes to stdout,
 *     which is where the platform collects it from.
 *
 *   - **Reads `process.env` directly, not `config/env.js`.** env.js throws
 *     when Supabase credentials are absent, which is correct for the server
 *     and wrong for a logger: the unit tests, and any future script that
 *     wants to log before config is validated, must not need a populated
 *     `.env` just to print a line.
 *
 *   - **Redaction is on key names, and errs towards over-redaction.** A
 *     bearer token in a log file is a live credential, so `keys`, `auth`
 *     and `endpoint` all disappear even though only some of them strictly
 *     need to. Losing a debuggable value is recoverable; leaking a session
 *     is not.
 */

/**
 * Keys whose values never appear in a log line.
 *
 * Matched case-insensitively against the key *name*, so this catches
 * `password`, `hashedPassword`, `SUPABASE_SERVICE_ROLE_KEY` and
 * `req.headers.authorization` alike without needing to enumerate them.
 *
 * `endpoint` is here because a Web Push endpoint is a device-identifying
 * capability URL. Push failures are logged against the subscription's row
 * id instead, which is just as diagnosable and not sensitive.
 */
const REDACTED_KEY =
  /pass|token|secret|authorization|bearer|jwt|cookie|session|credential|service_role|serviceRole|anon_key|anonKey|apikey|api_key|privateKey|private_key|p256dh|^auth$|^keys?$|^endpoint$/i;

const REDACTED = '[redacted]';

/** Long strings in logs are almost always a mistake — truncate rather than flood. */
const MAX_STRING = 512;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Minimum level to emit. Defaults to `debug` locally and `info` in
 * production, so query logs and cache-hit chatter don't fill a paid log
 * quota. `LOG_LEVEL=silent` turns logging off entirely, which the test
 * runner uses to keep its output readable.
 */
const threshold = () => {
  const configured = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (configured === 'silent') return Number.POSITIVE_INFINITY;
  if (LEVELS[configured]) return LEVELS[configured];
  return isProduction() ? LEVELS.info : LEVELS.debug;
};

/**
 * Recursively copies a value, replacing sensitive values and flattening
 * Errors into something JSON can represent.
 *
 * `seen` guards against circular references — Express request and Prisma
 * error objects both contain them, and a logger that throws while logging
 * an error is worse than no logger at all.
 */
const sanitise = (value, seen = new WeakSet(), depth = 0) => {
  if (value === null || value === undefined) return value;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      // Prisma and Supabase both put useful identifiers here.
      ...(value.code ? { code: value.code } : {}),
      ...(value.statusCode ? { statusCode: value.statusCode } : {}),
      // Stacks are noise in production log aggregation and essential
      // locally, so they follow the environment rather than the level.
      ...(isProduction() ? {} : { stack: value.stack }),
    };
  }

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }

  if (typeof value !== 'object') return value;

  // Deeply nested structures are usually an accidentally-logged ORM object.
  if (depth > 4) return '[depth limit]';

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    // Arrays of unknown length can be enormous (a broadcast recipient list).
    const capped = value.slice(0, 20).map((item) => sanitise(item, seen, depth + 1));
    return value.length > 20 ? [...capped, `…${value.length - 20} more`] : capped;
  }

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = REDACTED_KEY.test(key) ? REDACTED : sanitise(item, seen, depth + 1);
  }
  return out;
};

/** `{ requestId, userId }` → ` requestId=abc userId=def`, for the dev renderer. */
const formatContext = (context) => {
  const pairs = Object.entries(context)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
  return pairs.length ? ` ${pairs.join(' ')}` : '';
};

const write = (level, message, context = {}) => {
  if (LEVELS[level] < threshold()) return;

  const safe = sanitise(context);

  if (isProduction()) {
    // One JSON object per line — the format log drains expect.
    process.stdout.write(
      `${JSON.stringify({
        level,
        time: new Date().toISOString(),
        message,
        ...safe,
      })}\n`
    );
    return;
  }

  // Development: a single readable line, errors expanded underneath.
  const { err, ...rest } = safe;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`[${level}] ${message}${formatContext(rest)}\n`);
  if (err) stream.write(`${err.stack ?? `${err.name}: ${err.message}`}\n`);
};

export const logger = {
  debug: (message, context) => write('debug', message, context),
  info: (message, context) => write('info', message, context),
  warn: (message, context) => write('warn', message, context),
  error: (message, context) => write('error', message, context),

  /**
   * Returns a logger with fields pre-bound, so a handler doesn't have to
   * remember to pass the request id on every call — the whole reason the
   * old logging was impossible to correlate.
   */
  child(bound) {
    const bind = (level) => (message, context) => write(level, message, { ...bound, ...context });
    return {
      debug: bind('debug'),
      info: bind('info'),
      warn: bind('warn'),
      error: bind('error'),
      child: (more) => logger.child({ ...bound, ...more }),
    };
  },
};

/**
 * Security-relevant events, kept as its own call so they're greppable and
 * can be routed to an alert later without touching call sites.
 *
 * These are the lines you want when answering "did someone try?" — a
 * rejected privilege escalation, a failed admin action, a token that
 * didn't verify. Deliberately never carries the credential involved.
 */
export const securityLog = (event, context = {}) => {
  write('warn', `security.${event}`, { securityEvent: true, ...context });
};

/** Exported for the tests — the redaction rule is the part worth asserting. */
export const __testing = { sanitise, REDACTED, MAX_STRING };
