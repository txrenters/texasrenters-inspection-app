import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '../features/queries';
import { followPowerState } from '../lib/power-state';
import { isCaptureActive, subscribeToCaptureActivity } from '../media/capture-activity';
import { sweepReleasedRecordings } from '../media/recording-cleanup';
import { subscribeToVideoGate, videoGate } from '../media/video-hold';
import { snapshotsAwaitingUpload, uploadSnapshotNow } from '../media/snapshot-upload';
import { useDemoStore } from '../stores/demo.store';
import { verifyQueries } from '../features/state-consistency';
import { evaluateUploadGate } from '../lib/connectivity';
import { repositories } from '../repositories';
import { drainOfflineWrites } from '../repositories/api/offline-writes';
import { sendQueuedWrite } from '../repositories/api/repositories';
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
    // Deliberately not gated on AppState: on Android, where JS can keep running
    // for a while after backgrounding, refusing to start the next item just
    // wasted that window. `running` still prevents overlapping drains.
    //
    // A recording sent to Cloudflare is *not* a background transfer -- its
    // chunks are ordinary requests, which stop when the phone is locked. It
    // picks up from Cloudflare's confirmed offset when the app is next open,
    // and with a fresh upload link if the old one lapsed while it waited.
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
      /**
       * Photographs, after the recordings — and drained, not one per tick.
       *
       * A walkthrough video is the evidence an inspection cannot be finished
       * without, so it still goes first when the signal is poor. That ordering
       * is unchanged.
       *
       * What changed is the rate. This sent exactly one photograph per pass, on
       * the reasoning that they are "small and there are more of them". The
       * second half was right and the first was not: nothing downscaled a
       * capture, so each one is three to five megabytes — and at a four-second
       * interval, the twenty-five to thirty photographs of an occupied
       * inspection spent **a hundred seconds doing nothing at all**, on top of
       * the transfers themselves. A technician watching the queue after
       * finishing a property saw it crawl for no reason they could see.
       *
       * The store is still read fresh on every iteration, which is what made
       * the original one-per-pass rule safe: a photograph just marked FAILED
       * carries its backoff and `snapshotsAwaitingUpload` drops it from the
       * next look, so a failing queue walks its list once and stops rather than
       * retrying the same item in a tight loop. `MAX_DRAIN_PASSES` bounds it
       * either way.
       */
      for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
        // Photographs wait for a take to end as the recordings do.
        if (isCaptureActive()) break;
        const { snapshots, updateSnapshot } = useDemoStore.getState();
        const [due] = snapshotsAwaitingUpload(snapshots ?? []);
        if (!due) break;
        await uploadSnapshotNow(due, { update: updateSnapshot });
        uploaded += 1;
        // No uploads-list refresh here. That list is the recordings' alone --
        // no photograph ever appears in it -- so the request it cost after each
        // of an occupied visit's thirty photographs changed nothing on screen.
      }

      if (!uploaded) return;
      /**
       * An area submitted while its video was uploading waits in the offline
       * queue for exactly this (`RecordingStillUploadingError`). Sent now
       * rather than at the next change of signal, and before the refresh below,
       * so the area the refresh reads back is the one the server has completed.
       */
      await drainOfflineWrites(sendQueuedWrite).catch(() => undefined);
      await verifyQueries(client, [
        queryKeys.roomsRoot,
        queryKeys.roomRoot,
        // The area screen's own photo list, which `roomRoot` does not cover.
        // Without it a photograph landed on the server and the screen that
        // gates completion on one went on showing the list it had at open.
        queryKeys.roomPhotosRoot,
        queryKeys.dashboard,
      ]);
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
    // The moment a take ends, not up to four seconds later: the technician is
    // walking to the next room, and that walk is the upload's window.
    const unsubscribeCapture = subscribeToCaptureActivity((recording) => {
      if (!recording) void flush();
    });
    // And the moment a held video may go: a charger, Wi-Fi, or "Send now".
    const unsubscribeVideoGate = subscribeToVideoGate(() => {
      if (videoGate().allowed) void flush();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
      unsubscribeCapture();
      unsubscribeVideoGate();
    };
  }, [flush]);

  // Low Power Mode and the charger, as the phone announces them; read by the
  // video hold here and by the location task.
  useEffect(() => followPowerState(), []);

  // Recordings already handed to the server, from before they were deleted on
  // hand-over; see `recording-cleanup`. Once a launch, after the store loads.
  const hydrated = useDemoStore((state) => state.hasHydrated);
  useEffect(() => {
    if (hydrated) sweepReleasedRecordings();
  }, [hydrated]);

  return null;
}
