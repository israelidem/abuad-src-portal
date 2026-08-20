/**
 * Service worker registration and update handshake.
 *
 * Only runs in a production build. In dev the worker would sit in front
 * of Vite's module graph and serve stale assets over HMR, which looks
 * exactly like a caching bug that isn't there.
 *
 * Registration is deliberately non-fatal: the portal works fine without
 * a worker, so any failure here is logged and swallowed rather than
 * breaking startup.
 *
 * Update flow (see the header of public/sw.js for the worker half):
 *
 *   1. A new worker installs and then *waits* — it does not take over.
 *   2. We notice it and call `onUpdateReady`, which raises the "new
 *      version available" prompt.
 *   3. If the user accepts, `applyUpdate()` posts SKIP_WAITING.
 *   4. The new worker activates, `controllerchange` fires, we reload once.
 *
 * The reload is deliberately *not* automatic on step 2. Reloading a page
 * out from under someone mid-edit — half a ticket typed into a form —
 * loses their work. That's the whole reason this is a prompt.
 */

/**
 * Set when a waiting worker is detected before the UI has subscribed.
 *
 * Registration starts on `load` while the React tree mounts independently,
 * so the worker can be ready first. Without this the prompt would be
 * dropped on exactly the fast-cache case where the update is already
 * downloaded — and it would look like the feature works, because the
 * slower path still fires.
 */
let pendingRegistration = null;
let notify = null;

/** True once a reload has been triggered, so it can only happen once. */
let reloading = false;

/**
 * Subscribe to update-available events. Returns an unsubscribe function.
 *
 * Called from the React tree, which mounts after registration begins —
 * hence the replay of `pendingRegistration` below.
 */
export function onUpdateReady(callback) {
  notify = callback;
  if (pendingRegistration) callback();
  return () => {
    notify = null;
  };
}

/** Tell the waiting worker to activate. The reload follows from it. */
export function applyUpdate() {
  const waiting = pendingRegistration?.waiting;
  if (!waiting) {
    // The worker vanished between prompt and click (another tab accepted
    // first, or the browser dropped it). A plain reload still gets the
    // user onto current code, which is what they asked for.
    window.location.reload();
    return;
  }
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

function announce(registration) {
  pendingRegistration = registration;
  notify?.();
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  // Wait for load so the worker's install (and its cache.addAll) competes
  // with neither the first paint nor the initial API calls.
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        // A worker activating means the user is now running code older
        // than what the browser has. Reload — guarded, because
        // controllerchange can fire more than once.
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (reloading) return;
          reloading = true;
          window.location.reload();
        });

        // Already waiting when we registered: the update downloaded during
        // a previous visit and has been sitting there since.
        if (registration.waiting && navigator.serviceWorker.controller) {
          announce(registration);
        }

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;

          installing.addEventListener('statechange', () => {
            // `controller` is null on a first-ever install. That case is
            // not an update — there's no older code running and nothing
            // to prompt about, so it must stay silent.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              announce(registration);
            }
          });
        });

        // Check for a new deploy when the tab regains focus. Installed
        // PWAs can stay open for days and would otherwise never update.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            registration.update().catch(() => {});
          }
        });
      })
      .catch((error) => {
        console.warn('Service worker registration failed:', error);
      });
  });
}
