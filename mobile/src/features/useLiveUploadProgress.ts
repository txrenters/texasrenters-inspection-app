import { useMemo } from 'react';

import type { UploadItem } from '../domain/models';
import { useDemoStore } from '../stores/demo.store';

/**
 * Overlays live transfer progress onto the cached uploads list.
 *
 * The upload task reports progress by writing into the device store, but the
 * Uploads screen renders from a react-query cache snapshotted *before* the
 * transfer began — and nothing refetches while one is running. `refetchInterval`
 * only polls once an item is COMPLETED and still processing, and the queue
 * runner only writes back after a transfer resolves. So the bar sat at 0% for
 * the entire upload and then jumped to done, which is indistinguishable from an
 * upload that never started.
 *
 * Deliberately kept out of `useUploads`: that module sits inside the
 * `repositories` import graph, and importing the store from there left the
 * binding undefined at module-evaluation time and crashed the app on launch.
 * This module imports only the store and the domain types, so nothing can
 * close the loop.
 */
export function useLiveUploadProgress(cached: UploadItem[] | undefined): UploadItem[] {
  // A whole-array selector, never an object literal: zustand v5 compares with
  // Object.is, and `updateUpload` already replaces the array on every write.
  const live = useDemoStore((state) => state.uploads);

  return useMemo(() => {
    if (!cached?.length) return cached ?? [];
    if (!live.length) return cached;
    const byId = new Map(live.map((item) => [item.id, item]));
    // Cached order is preserved and no rows are invented: a store entry with no
    // cached counterpart is not part of the list being rendered yet, and adding
    // it here would duplicate on the next refetch.
    return cached.map((item) => byId.get(item.id) ?? item);
  }, [cached, live]);
}
