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
      const changed = await repositories.uploads.tick();
      if (!changed) return;
      client.setQueryData(queryKeys.uploads, await repositories.uploads.list());
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
