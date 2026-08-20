/**
 * Verifies the moderation API surface is real: routes registered, guards
 * attached, and the queue/word-list handlers actually reachable.
 *
 * Route registration is asserted rather than eyeballed because the failure
 * mode is silent — a router that throws on import leaves the whole /api/admin
 * tree 404ing, and a route missing `requireAdmin` looks identical in a diff
 * to one that has it.
 *
 * Run: node scripts/verify-moderation-api.mjs
 */

import router from '../src/routes/adminRoutes.js';
import { requireAuth, requireAdmin } from '../src/middleware/auth.js';
import { adminWriteLimiter } from '../src/middleware/rateLimiter.js';

let failures = 0;

const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// Express keeps one layer per route; each layer's stack holds the
// middleware chain in the order it will run.
const layers = router.stack.filter((l) => l.route);

const find = (method, path) =>
  layers.find((l) => l.route.path === path && l.route.methods[method]);

/**
 * The middleware functions attached to a route, in order.
 *
 * Compared by reference, not by name: requireAdmin and adminWriteLimiter are
 * both produced by factories, so their `.name` is '' and a name-based check
 * reports a missing guard on a route that is in fact guarded. Identity is
 * the only assertion that cannot be fooled either way.
 */
const handlers = (layer) => layer.route.stack.map((s) => s.handle);

const expected = [
  ['get', '/moderation/comments'],
  ['post', '/moderation/comments/:id/decision'],
  ['get', '/moderation/comments/:id/history'],
  ['get', '/moderation/words'],
  ['post', '/moderation/words'],
  ['patch', '/moderation/words/:id'],
  ['delete', '/moderation/words/:id'],
];

console.log(`\n-- routes registered (${layers.length} total on admin router) --`);

for (const [method, path] of expected) {
  const layer = find(method, path);
  check(`${method.toUpperCase()} ${path} registered`, Boolean(layer));
  if (!layer) continue;

  const fns = handlers(layer);

  // Every one of these is staff-only. A missing guard here is the exact
  // "user navigates to an admin URL" hole the brief calls out.
  check(`  ${method.toUpperCase()} ${path} requireAuth`, fns.includes(requireAuth));
  check(`  ${method.toUpperCase()} ${path} requireAdmin`, fns.includes(requireAdmin));

  // Order matters as much as presence: authentication has to resolve
  // req.user before the role check can read it.
  check(
    `  ${method.toUpperCase()} ${path} auth before role check`,
    fns.indexOf(requireAuth) < fns.indexOf(requireAdmin)
  );

  // Writes must also be rate-limited, or an authenticated admin session
  // becomes an unbounded write channel.
  if (method !== 'get') {
    check(`  ${method.toUpperCase()} ${path} rate-limited`, fns.includes(adminWriteLimiter));
  }
}

// The pre-existing ticket queue must survive the edit — it shares the file.
console.log('\n-- regression: routes that existed before this change --');
for (const [method, path] of [
  ['get', '/moderation'],
  ['get', '/settings'],
  ['patch', '/settings'],
  ['get', '/users'],
  ['patch', '/users/:id/role'],
  ['post', '/tickets/:id/reveal'],
  ['get', '/audit'],
]) {
  check(`${method.toUpperCase()} ${path} still registered`, Boolean(find(method, path)));
}

/**
 * Negative control.
 *
 * If the identity check above passed only because `fns.includes()` is
 * somehow always true, this would pass too — and it must not. It proves the
 * assertion can actually fail.
 */
console.log('\n-- negative control: the guard check can fail --');
const publicRoute = find('get', '/maintenance');
check(
  'GET /maintenance (deliberately public) has no requireAdmin',
  publicRoute && !handlers(publicRoute).includes(requireAdmin)
);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
