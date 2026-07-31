import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { persistQueryCache, restoreQueryCache } from '../storage/query-cache-persistence';

/**
 * Fills the query cache from disk on launch, then keeps disk in step with it.
 *
 * Returns true once the restore attempt has finished — successfully or not.
 * Callers should hold their first paint until then, otherwise screens mount
 * against an empty cache, show a spinner, and the restored data arrives a frame
 * later as a flash of replaced content.
 */
export function useQueryCacheHydration() {
  const client = useQueryClient();
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await restoreQueryCache(client);
      } finally {
        // Set even on failure: a device with no stored cache, or a payload we
        // rejected, still has to render.
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    // Subscribing before the restore finishes would let the first cache event
    // write an empty snapshot over the data we were about to read back.
    if (!hydrated) return;
    return persistQueryCache(client);
  }, [client, hydrated]);

  return hydrated;
}
