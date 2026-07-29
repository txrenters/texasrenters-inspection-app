import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '../features/queries';
import { verifyQueries } from '../features/state-consistency';
import { repositories } from '../repositories';

const FOREGROUND_QUEUE_INTERVAL_MS = 4_000;

/** Runs the durable device queue independently of whichever screen is open. */
export function UploadQueueRunner() {
  const client = useQueryClient();
  const running = useRef(false);

  const flush = useCallback(async () => {
    if (running.current || AppState.currentState !== 'active') return;
    running.current = true;
    try {
      const changed = await repositories.uploads.tick();
      if (!changed) return;
      client.setQueryData(queryKeys.uploads, await repositories.uploads.list());
      await verifyQueries(client, [
        queryKeys.roomsRoot,
        queryKeys.roomRoot,
        queryKeys.dashboard,
      ]);
    } finally {
      running.current = false;
    }
  }, [client]);

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
