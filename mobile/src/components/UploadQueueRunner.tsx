import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '../features/queries';
import { snapshotsAwaitingUpload, uploadSnapshotNow } from '../media/snapshot-upload';
import { useDemoStore } from '../stores/demo.store';
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

/**
 * Runs the durable device queues independently of whichever screen is open.
 *
 * Recordings and photographs both. Photographs had no runner at all: the
 * camera sent each one once and a failure ended in a bare catch, so a photo
 * taken in a basement stayed on the handset with nothing anywhere to send it
 * and nothing to say so.
 */
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
    // Deliberately not gated on AppState. Transfers use a background session,
    // so one already in flight survives the phone being locked or the app being
    // switched away — and on Android, where JS can keep running for a while
    // after backgrounding, refusing to start the next item just wasted that
    // window. `running` still prevents overlapping drains.
    if (!allowed || running.current) return;
    running.current = true;
    try {
      // Drain, rather than one recording per interval. `tick()` uploads at most
      // one item, so a technician who finished ten rooms used to watch the
      // queue idle for up to four seconds between each — 40 seconds of doing
      // nothing on top of the transfers themselves.
      let uploaded = 0;
      for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
        if (!(await repositories.uploads.tick())) break;
        uploaded += 1;
        // Refresh the list between items so the screen shows each one land,
        // instead of jumping at the end of the whole batch.
        client.setQueryData(queryKeys.uploads, await repositories.uploads.list());
      }
      // Photographs, after the recordings. They are small and there are more
      // of them, but a walkthrough video is the evidence an inspection cannot
      // be finished without, so it goes first when the signal is poor.
      //
      // One per pass: the store is read fresh each time, so a photo that has
      // just been marked FAILED carries its backoff and drops out of the next
      // pass rather than being retried immediately.
      const { snapshots, updateSnapshot } = useDemoStore.getState();
      const [due] = snapshotsAwaitingUpload(snapshots ?? []);
      if (due) {
        await uploadSnapshotNow(due, { update: updateSnapshot });
        uploaded += 1;
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
