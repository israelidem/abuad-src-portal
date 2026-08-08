/**
 * Web Push opt-in.
 *
 * Deliberately never asks for permission on mount. A permission prompt
 * fired on page load gets denied out of reflex, and a denial is sticky —
 * the user has to dig through site settings to undo it. The prompt only
 * happens on an explicit click via subscribe().
 */

import { useCallback, useEffect, useState } from 'react';

import { notificationApi } from '../lib/api.js';

/**
 * VAPID keys travel as base64url but pushManager.subscribe() wants raw
 * bytes. base64url swaps +/ for -_ and drops padding, so both have to be
 * restored before atob() will accept it.
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

const isSupported = () =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

export function usePushNotifications() {
  const [supported] = useState(isSupported);
  const [permission, setPermission] = useState(() =>
    isSupported() ? Notification.permission : 'denied'
  );
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Reflect the *browser's* state, not our own. The user can revoke a
  // subscription in site settings without the app ever hearing about it,
  // and a toggle stuck "on" would quietly lie.
  useEffect(() => {
    if (!supported) return;

    let cancelled = false;
    (async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (!cancelled) setSubscribed(Boolean(existing));
      } catch {
        if (!cancelled) setSubscribed(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [supported]);

  const subscribe = useCallback(async () => {
    if (!supported) return false;

    setBusy(true);
    setError(null);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') {
        setError('Notifications are blocked. You can re-enable them in your browser settings.');
        return false;
      }

      const { publicKey, enabled } = await notificationApi.vapidKey();
      if (!enabled || !publicKey) {
        setError('Push notifications are not available right now.');
        return false;
      }

      const registration = await navigator.serviceWorker.ready;

      // Reuse an existing subscription rather than creating a second one
      // for the same device — the browser only keeps one per registration
      // anyway, and subscribing again with different options throws.
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          // Required by Chrome: a subscription must always show a
          // notification, never silently sync in the background.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));

      await notificationApi.subscribe(subscription.toJSON());
      setSubscribed(true);
      return true;
    } catch (err) {
      setError(err.message ?? 'Could not enable notifications.');
      return false;
    } finally {
      setBusy(false);
    }
  }, [supported]);

  const unsubscribe = useCallback(async () => {
    if (!supported) return false;

    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        // Tell the server first. If the browser-side unsubscribe succeeded
        // but the API call failed, we'd keep pushing to a dead endpoint.
        await notificationApi.unsubscribe(subscription.endpoint).catch(() => {});
        await subscription.unsubscribe();
      }

      setSubscribed(false);
      return true;
    } catch (err) {
      setError(err.message ?? 'Could not turn off notifications.');
      return false;
    } finally {
      setBusy(false);
    }
  }, [supported]);

  return {
    supported,
    permission,
    subscribed,
    busy,
    error,
    // Permission survives an unsubscribe, so "denied" is the only truly
    // unrecoverable state from inside the page.
    blocked: permission === 'denied',
    subscribe,
    unsubscribe,
  };
}
