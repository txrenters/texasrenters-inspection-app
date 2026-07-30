import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '../features/queries';
import { verifyQueries } from '../features/state-consistency';
import { evaluateUploadGate } from '../lib/connectivity';
import { repositories } from '../repositories';
import { useNetworkStore } from '../stores/network.store';
import { usePreferencesStore } from '../stores/preferences.store';

const FOREGROUND_QUEUE_INTERVAL_MS = 4_000;
/**
 * Upper bound on back-to-back uploads in one pass.
 *
 * `tick()` also returns true when it *fails* an item, so without a bound a
 * queue that cannot make progress would spin. Deferred items get a future
 * `nextAttemptAt` and drop out on the next pass anyway.
 */
const MAX_DRAIN_PASSES = 25;

/** Runs the durable device queue independently of whichever screen is open. */
export function UploadQueueRunner() {
  const client = useQueryClient();
  const running = useRef(false);
  const autoUpload = usePreferencesStore((state) => state.autoUpload);
  const wifiOnlyUploads = usePreferencesStore((state) => state.wifiOnlyUploads);
  // Select primitives, never an object literal: zustand v5 compares with
  // Object.is, so a fresh object each render breaks the snapshot cache and
  // React loops on "getSnapshot should be cached".
  const isOnline = useNetworkStore((state) => state.isOnline);
  const isMetered = useNetworkStore((state) => state.isMetered);
  const allowed = evaluateUploadGate({
    autoUpload,
    wifiOnlyUploads,
    connectivity: { isOnline, isMetered, type: '' },
  }).allowed;

  const flush = useCallback(async () => {
    if (!allowed || running.current || AppState.currentState !== 'active') return;
    running.current = true;
    try {
      // Drain, rather than one recording per interval. `tick()` uploads at most
      // one item, so a technician who finished ten rooms used to watch the
      // queue idle for up to four seconds between each — 40 seconds of doing
      // nothing on top of the transfers themselves.
      let uploaded = 0;
      for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
        // Re-checked each pass: draining can outlast a backgrounding, and the
        // OS suspends the socket rather than failing it.
        if (AppState.currentState !== 'active') break;
        if (!(await repositories.uploads.tick())) break;
        uploaded += 1;
        // Refresh the list between items so the screen shows each one land,
        // instead of jumping at the end of the whole batch.
        client.setQueryData(queryKeys.uploads, await repositories.uploads.list());
      }
      if (!uploaded) return;
      await verifyQueries(client, [queryKeys.roomsRoot, queryKeys.roomRoot, queryKeys.dashboard]);
    } finally {
      running.current = false;
    }
  }, [allowed, client]);

  useEffect(() => {
    void flush();
    const timer = setInterval(() => void flush(), FOREGROUND_QUEUE_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') void flush();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [flush]);

  return null;
}
