import { useEffect } from 'react';

import { fetchConnectivity, subscribeToConnectivity } from '../lib/connectivity';
import { drainOfflineWrites } from '../repositories/api/offline-writes';
import { sendQueuedWrite } from '../repositories/api/repositories';
import { useNetworkStore } from '../stores/network.store';

/**
 * Headless: mirrors NetInfo into the network store for the lifetime of the
 * signed-in app. Mounted alongside `UploadQueueRunner` so connectivity is known
 * before the queue makes its first decision.
 *
 * Also the trigger for replaying writes held while offline. Here rather than in
 * a runner of its own because this is where the app already learns the network
 * came back, and a second subscriber would race this one.
 */
export function ConnectivitySync(): null {
  useEffect(() => {
    const setConnectivity = useNetworkStore.getState().setConnectivity;
    // Guards against two drains overlapping: a flapping connection emits
    // several times in a row, and each would otherwise start its own pass over
    // the same entries.
    let draining = false;
    const drain = () => {
      if (draining) return;
      draining = true;
      void drainOfflineWrites(sendQueuedWrite)
        .catch(() => undefined)
        .finally(() => {
          draining = false;
        });
    };

    const apply = (value: Parameters<typeof setConnectivity>[0]) => {
      setConnectivity(value);
      // Only on the way back. Draining while offline would spend attempts
      // against a connection that is not there.
      if (value.isOnline) drain();
    };

    // NetInfo only emits on *change*, so an app launched already offline would
    // sit at the optimistic default until the radio state moved. Seed it — and
    // this also sends anything left over from the last session.
    void fetchConnectivity().then(apply).catch(() => undefined);
    return subscribeToConnectivity(apply);
  }, []);

  return null;
}
