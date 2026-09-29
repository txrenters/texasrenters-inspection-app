import { ApiConnectionError } from '../src/storage/offline-record-cache';
import {
  QueuedOfflineError,
  drainOfflineWrites,
  jobStartEntryId,
  savedJobStarts,
  sendSavedFirst,
} from '../src/repositories/api/offline-writes';
import { readQueue } from '../src/storage/mutation-queue';
import { useNetworkStore } from '../src/stores/network.store';

/**
 * A started job stays started when the app is closed (the office, 2026-09-29:
 * "job should continue even if we close the app entirely, time should continue
 * too").
 *
 * Start job answers on the tap, so the app can be swiped away before the
 * request lands. The old queue kept a write only once its send had failed, and
 * a send cut off by closing the app never fails -- it just disappears.
 */

// Prefixed `mock` so jest permits the hoisted factory below to reference it.
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

jest.mock('../src/media/room-snapshot-flush', () => ({
  flushRoomSnapshotsNow: async () => undefined,
}));

const PRESSED_AT = '2026-09-29T15:02:11.000Z';
const entry = {
  id: jobStartEntryId('job-1'),
  kind: 'job-start',
  payload: { inspectionId: 'job-1', startedAt: PRESSED_AT },
};

beforeEach(() => {
  mockStore.clear();
  useNetworkStore.setState({ isOnline: true, isResolved: true });
});

describe('a start saved before it is sent', () => {
  it('is on the phone while the request is still out, which is when the app gets closed', async () => {
    let reply: (value: unknown) => void = () => undefined;
    const pending = sendSavedFirst(entry, () => new Promise((resolve) => (reply = resolve)));

    // The request has not answered. Closing the app here used to lose it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await readQueue()).map((saved) => saved.id)).toEqual([jobStartEntryId('job-1')]);
    expect(await savedJobStarts()).toEqual(new Map([['job-1', PRESSED_AT]]));

    reply({ id: 'job-1' });
    await pending;
    expect(await readQueue()).toEqual([]);
  });

  it('stays saved, and says so, when there is no signal', async () => {
    await expect(
      sendSavedFirst(entry, async () => {
        throw new ApiConnectionError('cannot connect', 'transport');
      }),
    ).rejects.toBeInstanceOf(QueuedOfflineError);
    expect(await savedJobStarts()).toEqual(new Map([['job-1', PRESSED_AT]]));
  });

  it('is dropped when the server refuses it, so the job does not read as started', async () => {
    const refusal = new Error('Only a scheduled inspection can be started.');
    await expect(
      sendSavedFirst(entry, async () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
    expect(await readQueue()).toEqual([]);
  });

  it('is sent on the next launch, with the moment Start job was pressed', async () => {
    // Left behind by an app closed mid-request.
    let never: (value: unknown) => void = () => undefined;
    void sendSavedFirst(entry, () => new Promise((resolve) => (never = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    void never;

    const sent: unknown[] = [];
    await drainOfflineWrites(async (path, method, body) => {
      sent.push({ path, method, body });
    });

    expect(sent).toEqual([
      { path: '/api/v1/technician/inspections/job-1/start', method: 'POST', body: { startedAt: PRESSED_AT } },
    ]);
    expect(await savedJobStarts()).toEqual(new Map());
  });
});
