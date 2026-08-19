/**
 * Latency measurement for the request path.
 *
 *   node scripts/measure-latency.mjs
 *
 * WHY
 *
 * There are two separate performance complaints, and they need separating
 * before anything is "fixed":
 *
 *   A. Render cold starts — a known property of the free tier.
 *   B. Pages still feel slow after the backend is warm.
 *
 * B is the interesting one, and it is easy to misattribute to Render and
 * then "solve" by moving hosts, which would change nothing. So this
 * measures the actual steps every authenticated request performs, in
 * isolation, against the real Supabase project.
 *
 * WHAT IT MEASURES
 *
 * requireAuth does two remote calls before any route handler runs:
 *
 *   1. supabaseAdmin.auth.getUser(token)  — HTTPS to Supabase Auth
 *   2. prisma.profile.findUnique(...)     — SQL to Supabase Postgres
 *
 * Both are network round trips. They are paid per request, so a page that
 * makes four API calls pays them four times. If that is the bottleneck,
 * no amount of frontend work or redeployment will help.
 *
 * It also times the list endpoints' own queries, so a slow *query* can be
 * told apart from slow *auth* — the audit flagged offset pagination and
 * count(*), and those need evidence before being rewritten.
 *
 * Read-only: it creates no rows and changes no settings.
 */

import { performance } from 'node:perf_hooks';

import { prisma } from '../src/lib/prisma.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

const RUNS = Number(process.env.RUNS ?? 8);

/** Runs fn RUNS times and reports the distribution, not just an average. */
const measure = async (label, fn) => {
  const timings = [];
  let note = '';

  for (let i = 0; i < RUNS; i += 1) {
    const started = performance.now();
    try {
      const result = await fn();
      if (typeof result === 'string') note = result;
    } catch (error) {
      console.log(`  ${label.padEnd(38)}  FAILED — ${error.message}`);
      return null;
    }
    timings.push(performance.now() - started);
  }

  timings.sort((a, b) => a - b);
  const ms = (n) => `${n.toFixed(0)}ms`.padStart(7);
  // Median and worst matter more than the mean here: the first call pays
  // connection setup, and an average hides that.
  console.log(
    `  ${label.padEnd(38)}  first ${ms(timings[0])}  median ${ms(
      timings[Math.floor(timings.length / 2)]
    )}  max ${ms(timings[timings.length - 1])}${note ? `   ${note}` : ''}`
  );

  return timings[Math.floor(timings.length / 2)];
};

const main = async () => {
  console.log(`\nMeasuring the request path (${RUNS} runs each)\n`);

  // A signed-in user is needed to time token verification. Any active
  // account will do; nothing is written.
  const someone = await prisma.profile.findFirst({
    where: { isActive: true },
    select: { id: true, email: true, role: true },
  });

  if (!someone) {
    console.error('No active profile to measure with.\n');
    process.exit(1);
  }

  // --- The per-request auth tax --------------------------------------
  console.log('requireAuth — paid by EVERY authenticated request');

  // A generated link gives a real, verifiable token without needing a
  // password, so this works against any environment.
  const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: someone.email,
  });

  let token = null;
  if (!linkError) {
    const hashed = linkData?.properties?.hashed_token;
    if (hashed) {
      const { data: verified } = await supabaseAdmin.auth.verifyOtp({
        type: 'magiclink',
        token_hash: hashed,
      });
      token = verified?.session?.access_token ?? null;
    }
  }

  let authMedian = null;
  if (token) {
    authMedian = await measure('supabaseAdmin.auth.getUser(token)', async () => {
      const { error } = await supabaseAdmin.auth.getUser(token);
      if (error) throw new Error(error.message);
    });
  } else {
    console.log('  supabaseAdmin.auth.getUser(token)       skipped — could not mint a token');
  }

  const profileMedian = await measure('prisma.profile.findUnique(id)', () =>
    prisma.profile.findUnique({ where: { id: someone.id } })
  );

  // --- Query costs the audit flagged ---------------------------------
  console.log('\nlist queries — the audit flagged offset pagination and count(*)');

  const total = await prisma.ticket.count();

  await measure('ticket.count() — whole table', () => prisma.ticket.count());

  await measure('tickets page 1 (offset 0)', () =>
    prisma.ticket.findMany({
      take: 20,
      skip: 0,
      orderBy: { createdAt: 'desc' },
      include: { author: { select: { id: true, fullName: true } } },
    })
  );

  // Offset pagination degrades with depth because the database must walk
  // and discard the skipped rows. With a few hundred tickets that is
  // invisible; the point is to know the shape before it isn't.
  const deepSkip = Math.max(0, total - 20);
  await measure(`tickets deep page (offset ${deepSkip})`, () =>
    prisma.ticket.findMany({
      take: 20,
      skip: deepSkip,
      orderBy: { createdAt: 'desc' },
      include: { author: { select: { id: true, fullName: true } } },
    })
  );

  await measure('unread notification count', () =>
    prisma.notification.count({ where: { userId: someone.id, isRead: false } })
  );

  await measure('settings row read', () => prisma.appSettings.findUnique({ where: { id: 1 } }));

  // --- Verdict -------------------------------------------------------
  console.log(`\n(${total} tickets in the table)\n`);

  if (authMedian !== null && profileMedian !== null) {
    const tax = authMedian + profileMedian;
    console.log(`Per-request auth overhead: ~${tax.toFixed(0)}ms (${authMedian.toFixed(0)}ms token + ${profileMedian.toFixed(0)}ms profile)`);
    console.log(`A page making 4 API calls pays roughly ${(tax * 4).toFixed(0)}ms of this before any work happens.`);

    if (authMedian > 80) {
      console.log(
        '\ngetUser() is a remote HTTPS call to Supabase Auth on every request.\n' +
          'This is the most likely cause of "slow even when warm", and it is\n' +
          'independent of the host — moving off Render would not change it.'
      );
    }
  }

  console.log('');
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
