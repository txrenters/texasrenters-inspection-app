import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Pull-to-refresh state that only reflects a refresh the technician asked for.
 *
 * Screens previously bound `RefreshControl`'s `refreshing` to react-query's
 * `isRefetching`, which is true for *any* refetch — including the 60-second
 * background poll on assignments. The spinner therefore appeared on its own
 * roughly once a minute, as though the app were reloading itself while someone
 * was reading the screen.
 *
 * Pass every query the pull should refresh; the spinner clears once they have
 * all settled, whether they succeed or fail.
 */
export function usePullToRefresh(refetchers: readonly (() => Promise<unknown>)[]) {
  const [refreshing, setRefreshing] = useState(false);
  // Guards a second pull landing mid-refresh, which would otherwise clear the
  // spinner as soon as the *first* batch returned.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  // Held in a ref rather than a dependency: callers pass an inline array, whose
  // identity changes every render and would rebuild the callback each time.
  const latest = useRef(refetchers);
  latest.current = refetchers;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onRefresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    void (async () => {
      try {
        // allSettled, not all: one failing query must not strand the spinner
        // on screen forever.
        await Promise.allSettled(latest.current.map((refetch) => refetch()));
      } finally {
        inFlight.current = false;
        if (mounted.current) setRefreshing(false);
      }
    })();
  }, []);

  return { refreshing, onRefresh };
}
