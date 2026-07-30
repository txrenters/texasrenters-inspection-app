import { useEffect } from 'react';

import { fetchConnectivity, subscribeToConnectivity } from '../lib/connectivity';
import { useNetworkStore } from '../stores/network.store';

/**
 * Headless: mirrors NetInfo into the network store for the lifetime of the
 * signed-in app. Mounted alongside `UploadQueueRunner` so connectivity is known
 * before the queue makes its first decision.
 */
export function ConnectivitySync(): null {
  useEffect(() => {
    const setConnectivity = useNetworkStore.getState().setConnectivity;
    // NetInfo only emits on *change*, so an app launched already offline would
    // sit at the optimistic default until the radio state moved. Seed it.
    void fetchConnectivity()
      .then(setConnectivity)
      .catch(() => undefined);
    return subscribeToConnectivity(setConnectivity);
  }, []);

  return null;
}
