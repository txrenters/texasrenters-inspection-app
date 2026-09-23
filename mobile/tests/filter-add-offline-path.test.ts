/**
 * Started as a diagnosis scratch test (2026-09-23): does the offline-queue
 * path explain "an added AC filter only appears after restarting the app"?
 *
 * The first half found a second bug and no longer asserts current behaviour:
 * the queue held a write for *any* `ApiConnectionError`, a 500 included, so a
 * phone on full bars was told its work would send "when you are back on a
 * network". `classifyWriteFailure` narrowed that, and these cases became the
 * requirement — see `offline-write-classification.test.ts` for the full rule
 * and `api-failure-reasons.test.ts` for the causes it runs on.
 *
 * The react-query half below is the filter bug itself, and stands as written.
 */
import { QueryClient } from '@tanstack/react-query';

import { ApiConnectionError } from '../src/storage/offline-record-cache';
import { QueuedOfflineError, queueOnConnectionFailure } from '../src/repositories/api/offline-writes';
import { reconcileMobileState } from '../src/features/state-consistency';
import { useNetworkStore } from '../src/stores/network.store';
import { filterRows, withAddedFilter } from '../src/utils/job-tasks';

const mockStore = new Map<string, string>();

jest.mock('../src/storage/demo-storage', () => ({
  demoStorage: {
    getItem: async (key: string) => mockStore.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      mockStore.set(key, value);
    },
    removeItem: async (key: string) => {
      mockStore.delete(key);
    },
  },
}));

jest.mock('../src/media/room-snapshot-flush', () => ({ flushRoomSnapshotsNow: async () => undefined }));

beforeEach(() => {
  mockStore.clear();
  // The phone in the bug report: full bars, and an API that is answering.
  useNetworkStore.setState({ isOnline: true, isResolved: true });
});

const entry = { id: 'services:job-1', kind: 'job-services', payload: { inspectionId: 'job-1' } };
const queue = () => mockStore.get('texasrenters-mutation-queue-v1');

describe('what queueOnConnectionFailure treats as "the device could not reach us"', () => {
  it('does NOT queue a 500 — the app answered, and may answer the same forever', async () => {
    const fault = new ApiConnectionError('TexasRenters API request failed (500).', 'fault');

    await expect(
      queueOnConnectionFailure(entry, async () => {
        throw fault;
      }),
      // The server's own error reaches the technician, rather than a promise
      // that the work will send once they find a network they never lost.
    ).rejects.toBe(fault);
    expect(queue()).toBeUndefined();
  });

  it('queues a 503, because the edge answered it without reaching the app', async () => {
    await expect(
      queueOnConnectionFailure(entry, async () => {
        throw new ApiConnectionError('TexasRenters API request failed (503).', 'unavailable');
      }),
      // Held so a deploy stays invisible — but described as ours, not theirs.
    ).rejects.toMatchObject({ name: 'QueuedOfflineError', reason: 'server' });
    expect(JSON.parse(queue()!)).toHaveLength(1);
  });

  it('queues a 15s timeout abort, without calling an online phone offline', async () => {
    await expect(
      queueOnConnectionFailure(entry, async () => {
        throw new ApiConnectionError('The TexasRenters API did not respond in time.', 'timeout');
      }),
    ).rejects.toMatchObject({ name: 'QueuedOfflineError', reason: 'server' });
    expect(JSON.parse(queue()!)).toHaveLength(1);
  });

  it('does NOT queue a 4xx (plain Error)', async () => {
    await expect(
      queueOnConnectionFailure(entry, async () => {
        throw new Error('TexasRenters API request failed (400).');
      }),
    ).rejects.not.toBeInstanceOf(QueuedOfflineError);
    expect(queue()).toBeUndefined();
  });
});

/**
 * A faithful transcription of `saveServices.mutationFn` + `onError`
 * (mobile/src/features/queries.ts:438-465), run against a real QueryClient
 * carrying the app's `structuralSharing`.
 */
describe('the react-query cache on the queued path', () => {
  const key = ['inspection', 'job-1'];
  const visitDetails = 'Filters: 20x25x1 Hallway';

  const makeClient = () =>
    new QueryClient({
      defaultOptions: { queries: { structuralSharing: reconcileMobileState, retry: false } },
    });

  const runMutationFn = async (
    client: QueryClient,
    update: (current: any) => any,
    save: (report: any) => Promise<any>,
  ) => {
    await client.cancelQueries({ queryKey: key });
    const current = client.getQueryData<any>(key)?.servicesReport ?? null;
    const servicesReport = update(current);
    client.setQueryData(key, (job?: any) => (job ? { ...job, servicesReport } : job));
    return save(servicesReport);
  };

  it('holds the added filter BEFORE the repository call, so a queued write cannot hide it', async () => {
    const client = makeClient();
    client.setQueryData(key, { id: 'job-1', visitDetails, servicesReport: null });

    let cacheAtSendTime: unknown;
    await expect(
      runMutationFn(
        client,
        (current) => withAddedFilter(current, { size: '16x20x1', location: 'Attic', slot: 1 }),
        async () => {
          // Snapshot what the screen would render at the moment the request goes out.
          cacheAtSendTime = client.getQueryData(key);
          throw new QueuedOfflineError();
        },
      ),
    ).rejects.toBeInstanceOf(QueuedOfflineError);

    const job = cacheAtSendTime as any;
    expect(job.servicesReport.filters).toHaveLength(1);
    // The row the technician expects, already renderable from the cache the
    // screen subscribes to — before the request has even been answered.
    const rows = filterRows(job.visitDetails, job.servicesReport);
    expect(rows.map((row) => row.label)).toContain('16x20x1 · Attic');
    expect(rows.length).toBe(filterRows(job.visitDetails, null).length + 1);
  });

  it('onError leaves the optimistic write standing for a QueuedOfflineError', () => {
    const client = makeClient();
    client.setQueryData(key, { id: 'job-1', visitDetails, servicesReport: null });
    const before = client.getQueryData(key);
    // onError: `if (!(error instanceof QueuedOfflineError)) void refresh();`
    const error: unknown = new QueuedOfflineError();
    if (!(error instanceof QueuedOfflineError)) client.invalidateQueries({ queryKey: key });
    expect(client.getQueryData(key)).toBe(before);
  });

  it('structuralSharing does not drop an appended, id-less filter', () => {
    const client = makeClient();
    const seeded = {
      id: 'job-1',
      visitDetails,
      servicesReport: { filters: [{ size: '20x25x1', location: 'Hallway', slot: 1, booked: true }] },
    };
    client.setQueryData(key, seeded);
    client.setQueryData(key, (job: any) => ({
      ...job,
      servicesReport: withAddedFilter(job.servicesReport, {
        size: '16x20x1',
        location: 'Attic',
        slot: 1,
      }),
    }));
    expect(client.getQueryData<any>(key).servicesReport.filters).toHaveLength(2);
  });
});
