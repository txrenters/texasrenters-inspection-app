/**
 * Diagnosis scratch test (2026-09-23): does the offline-queue path explain
 * "an added AC filter only appears after restarting the app"?
 *
 * Keep or delete freely — this asserts current behaviour, not a requirement.
 */
import { QueryClient } from '@tanstack/react-query';

import { ApiConnectionError } from '../src/storage/offline-record-cache';
import { QueuedOfflineError, queueOnConnectionFailure } from '../src/repositories/api/offline-writes';
import { reconcileMobileState } from '../src/features/state-consistency';
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

beforeEach(() => mockStore.clear());

const entry = { id: 'services:job-1', kind: 'job-services', payload: { inspectionId: 'job-1' } };

describe('queueOnConnectionFailure queues on more than "the device is offline"', () => {
  it('queues a 5xx, which requestJson reports as ApiConnectionError while online', async () => {
    await expect(
      queueOnConnectionFailure(entry, async () => {
        throw new ApiConnectionError('TexasRenters API request failed (500).');
      }),
    ).rejects.toBeInstanceOf(QueuedOfflineError);
    expect(JSON.parse(mockStore.get('texasrenters-mutation-queue-v1')!)).toHaveLength(1);
  });

  it('queues a 15s timeout abort the same way', async () => {
    await expect(
      queueOnConnectionFailure(entry, async () => {
        throw new ApiConnectionError('The TexasRenters API did not respond in time.');
      }),
    ).rejects.toBeInstanceOf(QueuedOfflineError);
    expect(JSON.parse(mockStore.get('texasrenters-mutation-queue-v1')!)).toHaveLength(1);
  });

  it('does NOT queue a 4xx (plain Error)', async () => {
    await expect(
      queueOnConnectionFailure(entry, async () => {
        throw new Error('TexasRenters API request failed (400).');
      }),
    ).rejects.not.toBeInstanceOf(QueuedOfflineError);
    expect(mockStore.get('texasrenters-mutation-queue-v1')).toBeUndefined();
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
