import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { useNetworkStore } from '../stores/network.store';
import { drainLocationQueue } from './location-sender';

/**
 * Sends whatever the location task has collected.
 *
 * Independent of the on-shift toggle on purpose. A technician who finishes a
 * shift in a basement still has fixes on the handset, and a runner that only
 * ran while tracking was on would leave them there until the next shift — or
 * for ever, if that was their last day on the app.
 *
 * Deliberately not gated on `autoUpload` or `wifiOnlyUploads` either. Those
 * exist because a walkthrough video is tens of megabytes on a personal data
 * plan; a batch of coordinates is a few hundred bytes, and holding a position
 * trail back to save that is the wrong trade.
 *
 * Fifteen seconds, matching the fix interval. A minute meant the console could
 * be a minute behind a technician who was moving, which is not what anybody
 * means by a live map. The payload is a handful of coordinates.
 */
const DRAIN_INTERVAL_MS = 15_000;

export function LocationShiftRunner() {
  const running = useRef(false);
  const isOnline = useNetworkStore((state) => state.isOnline);

  const drain = useCallback(async () => {
    if (!isOnline || running.current) return;
    running.current = true;
    try {
      // One batch per tick, not a loop. The queue is bounded and a minute is
      // frequent enough to clear a long outage within a shift, while a drain
      // loop on a handset that has just regained signal competes with the
      // uploads of the evidence that actually matters.
      await drainLocationQueue();
    } finally {
      running.current = false;
    }
  }, [isOnline]);

  useEffect(() => {
    void drain();
    const timer = setInterval(() => void drain(), DRAIN_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') void drain();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [drain]);

  return null;
}
