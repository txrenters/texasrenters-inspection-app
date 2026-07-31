import type { UploadItem } from '../src/domain/models';

/**
 * The merge that makes the progress bar move.
 *
 * The transfer writes progress into the device store; the Uploads screen reads
 * a react-query cache snapshotted *before* the upload began, and nothing
 * refetches during a transfer. Without merging the store over the snapshot the
 * bar sits at 0% for the whole upload and then jumps straight to done — which
 * is indistinguishable from an upload that never started.
 *
 * Extracted here as the same pure operation `useUploads` performs, so the rule
 * is testable without mounting react-query and the native upload task.
 */
function mergeLiveProgress(
  cached: UploadItem[] | undefined,
  live: UploadItem[],
): UploadItem[] | undefined {
  if (!cached?.length || !live.length) return cached;
  const byId = new Map(live.map((item) => [item.id, item]));
  return cached.map((item) => byId.get(item.id) ?? item);
}

function upload(overrides: Partial<UploadItem> = {}): UploadItem {
  return {
    id: 'local-upload-1',
    mediaId: 'media-1',
    inspectionId: 'insp-1',
    roomId: 'room-1',
    propertyAddress: '1 Main St',
    roomName: 'Kitchen',
    durationSeconds: 90,
    estimatedSizeMb: 42,
    status: 'PENDING',
    progress: 0,
    processingStatus: 'NOT_STARTED',
    processingProgress: 0,
    createdAt: '2026-07-31T00:00:00.000Z',
    ...overrides,
  } as UploadItem;
}

describe('live upload progress merge', () => {
  it('replaces the stale cached progress with what the transfer reports', () => {
    const cached = [upload({ progress: 0, status: 'PENDING' })];
    const live = [upload({ progress: 0.42, status: 'UPLOADING' })];
    const merged = mergeLiveProgress(cached, live)!;
    expect(merged[0]!.progress).toBe(0.42);
    expect(merged[0]!.status).toBe('UPLOADING');
  });

  it('leaves server-backed uploads untouched', () => {
    // Only device-local items exist in the store; remote rows must survive.
    const cached = [upload({ id: 'remote-1', progress: 1, status: 'COMPLETED' })];
    const live = [upload({ id: 'local-upload-1', progress: 0.5 })];
    const merged = mergeLiveProgress(cached, live)!;
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe('remote-1');
    expect(merged[0]!.progress).toBe(1);
  });

  it('preserves the cached order rather than reordering by the store', () => {
    const cached = [upload({ id: 'a' }), upload({ id: 'b' }), upload({ id: 'c' })];
    const live = [upload({ id: 'c', progress: 0.9 }), upload({ id: 'a', progress: 0.1 })];
    const merged = mergeLiveProgress(cached, live)!;
    expect(merged.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(merged.map((item) => item.progress)).toEqual([0.1, 0, 0.9]);
  });

  it('does not invent rows the cache does not have', () => {
    // A store entry with no cached counterpart is not yet in the list the
    // screen is rendering; adding it here would duplicate on the next refetch.
    const cached = [upload({ id: 'a' })];
    const live = [upload({ id: 'a' }), upload({ id: 'unlisted' })];
    expect(mergeLiveProgress(cached, live)).toHaveLength(1);
  });

  it('passes through cleanly when either side is empty', () => {
    expect(mergeLiveProgress(undefined, [upload()])).toBeUndefined();
    expect(mergeLiveProgress([], [upload()])).toEqual([]);
    const cached = [upload({ progress: 0.3 })];
    expect(mergeLiveProgress(cached, [])).toBe(cached);
  });
});
