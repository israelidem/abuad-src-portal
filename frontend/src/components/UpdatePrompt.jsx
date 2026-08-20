/**
 * Raises the "new version available" toast when a service worker update
 * is waiting.
 *
 * Renders nothing. It exists as a component only because `useToast` is a
 * hook and the subscription therefore has to live inside the React tree,
 * under <ToastProvider>.
 *
 * See lib/registerSW.js for the handshake this drives.
 */

import { useEffect } from 'react';

import { useToast } from '../context/ToastContext.jsx';
import { applyUpdate, onUpdateReady } from '../lib/registerSW.js';

export default function UpdatePrompt() {
  const toast = useToast();

  useEffect(() => {
    // duration 0 — this must not time out. The update stays waiting until
    // the user acts on it, so a toast that vanished after five seconds
    // would leave them on stale code with no way back to the prompt.
    return onUpdateReady(() => {
      toast.info('A new version of the portal is available.', 0, {
        label: 'Reload now',
        onClick: applyUpdate,
      });
    });
  }, [toast]);

  return null;
}
