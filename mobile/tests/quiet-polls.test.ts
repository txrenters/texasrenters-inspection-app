import { QueryClient } from '@tanstack/react-query';

import type { UploadItem } from '../src/domain/models';
import { UPLOAD_POLL_WINDOW_MS, uploadsPollInterval } from '../src/features/queries';
import { reconcileMobileState } from '../src/features/state-consistency';
import { changesWhatIsStored } from '../src/storage/query-cache-persistence';

/**
 * Work the phone did in the background of a move-out for nothing (2026-10-06):
 * polls that never stopped, a re-render on every poll that changed nothing, and
 * the whole query cache rewritten to disk each time.
 */

const NOW = Date.parse('2026-10-06T15:00:00.000Z');
const video = (
  patch: Partial<Pick<UploadItem, 'status' | 'processingStatus'>> & { minutesAgo?: number } = {},
) => ({
  status: patch.status ?? ('COMPLETED' as const),
  processingStatus: patch.processingStatus ?? ('VIDEO_PROCESSING' as const),
  createdAt: new Date(NOW - (patch.minutesAgo ?? 3) * 60_000).toISOString(),
});

describe('the uploads list poll', () => {
  it('runs while a recent video is still being processed', () => {
    expect(uploadsPollInterval([video()], NOW)).toBe(5_000);
  });

  it('stops once every video is ready or failed', () => {
    expect(uploadsPollInterval([video({ processingStatus: 'READY_FOR_REVIEW' })], NOW)).toBe(false);
    expect(uploadsPollInterval([video({ processingStatus: 'FAILED' })], NOW)).toBe(false);
  });

  it('gives up on a video stuck far longer than processing ever takes', () => {
    // One stuck row used to keep every phone that listed it polling for good.
    const stuck = video({ minutesAgo: UPLOAD_POLL_WINDOW_MS / 60_000 + 1 });
    expect(uploadsPollInterval([stuck], NOW)).toBe(false);
  });

  it('does not poll for a video still on its way up', () => {
    expect(uploadsPollInterval([video({ status: 'UPLOADING' })], NOW)).toBe(false);
  });
});

describe('a poll that changed nothing', () => {
  it('keeps the data it had, so nothing re-renders', () => {
    const previous = { items: [{ id: 'a', name: 'Kitchen' }], total: 1 };
    const incoming = JSON.parse(JSON.stringify(previous)) as typeof previous;
    expect(reconcileMobileState(previous, incoming)).toBe(previous);
  });

  it('replaces only what changed', () => {
    const kitchen = { id: 'a', name: 'Kitchen' };
    const previous = { items: [kitchen, { id: 'b', name: 'Bath' }] };
    const incoming = { items: [{ id: 'a', name: 'Kitchen' }, { id: 'b', name: 'Bathroom' }] };
    const next = reconcileMobileState(previous, incoming);
    expect(next).not.toBe(previous);
    expect(next.items[0]).toBe(kitchen);
    expect(next.items[1].name).toBe('Bathroom');
  });

  it('is not written to disk again', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, structuralSharing: reconcileMobileState } },
    });
    const writes: boolean[] = [];
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'success') writes.push(changesWhatIsStored(event));
    });

    client.setQueryData(['rooms'], { items: [{ id: 'a' }] });
    client.setQueryData(['rooms'], { items: [{ id: 'a' }] });
    client.setQueryData(['rooms'], { items: [{ id: 'b' }] });

    expect(writes).toEqual([true, false, true]);
    unsubscribe();
    client.clear();
  });
});
