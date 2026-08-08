/**
 * Ticket list fetching, keyed off URL search params.
 *
 * Filters live in the URL rather than component state, so a filtered
 * view can be shared or bookmarked and the back button steps through
 * filter changes.
 *
 * In-flight requests are aborted when the params change, which stops a
 * slow earlier response from overwriting a newer one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ticketApi } from '../lib/api.js';

export function useTickets(params) {
  const [tickets, setTickets] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Serialised so the effect compares by value, not object identity
  const key = JSON.stringify(params);
  const controller = useRef(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    controller.current = new AbortController();

    setLoading(true);
    setError(null);

    try {
      const data = await ticketApi.list(params, { signal: controller.current.signal });
      setTickets(data.tickets);
      setPagination(data.pagination);
    } catch (err) {
      if (err.name === 'AbortError') return; // superseded, not a failure
      setError(err.message);
      setTickets([]);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    // Fetch-on-mount. `load` flips `loading` synchronously so the list
    // shows a spinner on the first paint rather than an empty state that
    // flashes to content; the request is aborted on cleanup. Without a
    // data-fetching library this is the intended escape hatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => controller.current?.abort();
  }, [load]);

  /** Patches one ticket in place after a vote, avoiding a full refetch. */
  const applyVote = useCallback((id, { hasVoted, upvoteCount }) => {
    setTickets((current) =>
      current.map((t) => (t.id === id ? { ...t, hasVoted, upvoteCount } : t))
    );
  }, []);

  return { tickets, pagination, loading, error, reload: load, applyVote };
}
