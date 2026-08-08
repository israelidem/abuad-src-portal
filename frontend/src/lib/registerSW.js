/**
 * Service worker registration.
 *
 * Only runs in a production build. In dev the worker would sit in front
 * of Vite's module graph and serve stale assets over HMR, which looks
 * exactly like a caching bug that isn't there.
 *
 * Registration is deliberately non-fatal: the portal works fine without
 * a worker, so any failure here is logged and swallowed rather than
 * breaking startup.
 */

export function registerServiceWorker() {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  // Wait for load so the worker's install (and its cache.addAll) competes
  // with neither the first paint nor the initial API calls.
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        // A new worker activating while tabs are open means the user is
        // running code older than the deploy. Reload once — guarded, or
        // controllerchange during a skipWaiting loop reloads forever.
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (refreshing) return;
          refreshing = true;
          window.location.reload();
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
