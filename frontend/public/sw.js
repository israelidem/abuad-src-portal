/**
 * Service worker — offline shell, asset caching and Web Push.
 *
 * Lives in public/ so it is served from the origin root and gets a "/"
 * scope. A worker under /assets/ could only control /assets/.
 *
 * Caching policy, deliberately narrow:
 *
 *   /api/*        never cached. Responses are per-user and auth'd; a
 *                 shared Cache Storage entry would show one student's
 *                 tickets to the next person on a shared phone. Stale
 *                 ticket state is also actively misleading — "resolved"
 *                 when it isn't erodes trust in the portal.
 *   Supabase      same, plus tokens. Never cached.
 *   /assets/*     cache-first. Vite fingerprints these, so a given URL is
 *                 immutable and can be served from cache indefinitely.
 *   navigations   network-first, falling back to the cached shell so a
 *                 cold offline launch shows the app instead of the
 *                 browser's dinosaur.
 *
 * Bump CACHE_VERSION to evict everything on the next activation.
 */

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `src-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `src-assets-${CACHE_VERSION}`;

// index.html is the SPA shell; the icons make the offline page look right.
const SHELL_URLS = ['/', '/index.html', '/favicon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individually, so one 404 doesn't fail the whole install
      await Promise.allSettled(SHELL_URLS.map((url) => cache.add(new Request(url))));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

/** True for anything user-specific or credentialed. */
const isPrivate = (url) =>
  url.pathname.startsWith('/api/') ||
  url.hostname.endsWith('.supabase.co') ||
  url.pathname.startsWith('/auth/');

const isHashedAsset = (url) =>
  url.origin === self.location.origin &&
  (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/'));

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET is cacheable, and a POST must never be replayed from cache.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (isPrivate(url)) return; // straight to network, untouched

  if (isHashedAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;

        const response = await fetch(request);
        // Opaque (cross-origin, no-cors) responses have status 0 and are
        // not worth storing — they can't be inspected or validated.
        if (response.ok) cache.put(request, response.clone());
        return response;
      })()
    );
    return;
  }

  // Navigations: try the network so a deployed update is picked up, and
  // fall back to the shell when offline. React Router handles the path.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match('/index.html')) ??
            (await cache.match('/')) ??
            new Response('You are offline.', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' },
            })
          );
        }
      })()
    );
  }
});

// ------------------------------------------------------------
// Web Push
// ------------------------------------------------------------

self.addEventListener('push', (event) => {
  // A push with no/!JSON payload still needs to show something —
  // browsers penalise (and eventually revoke) silent pushes.
  let payload;
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { body: event.data?.text() };
  }

  const title = payload.title ?? 'ABUAD SRC Portal';
  const options = {
    body: payload.body ?? 'You have a new update.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-64.png',
    // Collapses repeat notifications for the same ticket instead of
    // stacking five entries for one thread.
    tag: payload.tag ?? 'src-portal',
    renotify: Boolean(payload.tag),
    data: { link: payload.link ?? '/dashboard' },
  };

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);

      // Tell any open tab to refresh its bell.
      //
      // Without this the in-app list and the unread badge stay stale until
      // the next 60s poll, so a student could be looking at the portal,
      // receive a system notification, and see nothing change on the page
      // they are actually reading. The tab decides what to do with this —
      // the worker deliberately doesn't know about the API or the token.
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        client.postMessage({ type: 'notification', link: options.data.link });
      }
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data?.link ?? '/dashboard';

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // Reuse an open tab rather than piling up new ones
      for (const client of clientList) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) await client.navigate(link);
          return;
        }
      }

      await self.clients.openWindow(link);
    })()
  );
});
