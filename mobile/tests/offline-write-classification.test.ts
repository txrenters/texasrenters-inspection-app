import { ApiConnectionError } from '../src/storage/offline-record-cache';
import {
  QueuedOfflineError,
  classifyWriteFailure,
  drainOfflineWrites,
  queueOnConnectionFailure,
} from '../src/repositories/api/offline-writes';
import { QUEUE_ENTRY_MAX_ATTEMPTS, drainQueue, enqueueMutation, readQueue } from '../src/storage/mutation-queue';
import { useNetworkStore } from '../src/stores/network.store';

/**
 * What counts as "the device could not reach us".
 *
 * The queue used to hold a write for any `ApiConnectionError`, which is also
 * every 5xx — so an online phone talking to an API that was up and throwing
 * 500s was told "Saved on this device. It will send when you are back on a
 * network", and the write was replayed against an answer that was never going
 * to change. The technician goes looking for signal that was never missing,
 * and eight drains later the entry is dropped with nobody watching.
 *
 * Grew out of the diagnosis scratch test written for the added-filter bug
 * (#307), which pinned the old behaviour to prove it. These are the same
 * cases, asserted as the requirement.
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

beforeEach(() => {
  mockStore.clear();
  // The store is the app's own answer to "can we reach the backend": NetInfo
  // probes /api/v1/health rather than a third party. Default the tests to a
  // phone that believes it is online, which is the case the bug was about.
  useNetworkStore.setState({ isOnline: true, isResolved: true });
});

const entry = { id: 'services:job-1', kind: 'job-services', payload: { inspectionId: 'job-1' } };
const held = async (error: unknown) =>
  queueOnConnectionFailure(entry, () => Promise.reject(error));
const queued = () => readQueue();

describe('classifyWriteFailure', () => {
  it('holds a transport failure as offline — nothing left the handset', () => {
    const error = new ApiConnectionError('cannot connect', 'transport');
    expect(classifyWriteFailure(error, true)).toEqual({ hold: true, reason: 'offline' });
    expect(classifyWriteFailure(error, false)).toEqual({ hold: true, reason: 'offline' });
  });

  /**
   * A deploy is thirty seconds of 503. The request never reached the app, so
   * holding it is safe and makes the restart invisible — but the device is on
   * a network, so it must not be told otherwise.
   */
  it('holds 502/503/504, but never calls the device offline', () => {
    const error = new ApiConnectionError('bad gateway', 'unavailable');
    expect(classifyWriteFailure(error, true)).toEqual({ hold: true, reason: 'server' });
    expect(classifyWriteFailure(error, false)).toEqual({ hold: true, reason: 'server' });
  });

  /**
   * The one case the app genuinely cannot read, so it holds either way and
   * lets connectivity choose only the wording. The two possible mistakes are
   * not equal: holding a hung endpoint's write costs a bounded number of
   * retries, surfacing a crawling connection's costs a technician their work
   * in exactly the basement the queue exists for.
   */
  it('holds a timeout either way, and words it by what the device believes', () => {
    const error = new ApiConnectionError('did not respond in time', 'timeout');
    expect(classifyWriteFailure(error, false)).toEqual({ hold: true, reason: 'offline' });
    expect(classifyWriteFailure(error, true)).toEqual({ hold: true, reason: 'server' });
  });

  /**
   * The regression. The app received the request and chose to fail on it, and
   * may choose the same for this payload forever — which is the argument the
   * queue already made about a 4xx.
   */
  it('does NOT hold a 500 the app produced itself', () => {
    const error = new ApiConnectionError('request failed (500)', 'fault');
    expect(classifyWriteFailure(error, true)).toEqual({ hold: false });
    expect(classifyWriteFailure(error, false)).toEqual({ hold: false });
  });

  it('does NOT hold a 4xx, which was never an ApiConnectionError', () => {
    expect(classifyWriteFailure(new Error('request failed (400)'), false)).toEqual({ hold: false });
  });
});

describe('queueOnConnectionFailure', () => {
  it('lets a 500 through to the technician instead of queueing it', async () => {
    const error = new ApiConnectionError('TexasRenters API request failed (500).', 'fault');

    // The server's own error, not a reassurance: the screen rolls back to what
    // was really stored and the office's error log gets told.
    await expect(held(error)).rejects.toBe(error);
    expect(await queued()).toHaveLength(0);
  });

  it('holds a transport failure and says the device is offline', async () => {
    await expect(held(new ApiConnectionError('cannot connect', 'transport'))).rejects.toMatchObject({
      name: 'QueuedOfflineError',
      reason: 'offline',
    });
    expect(await queued()).toHaveLength(1);
  });

  it('holds a 503 without claiming the device is offline', async () => {
    await expect(held(new ApiConnectionError('unavailable', 'unavailable'))).rejects.toMatchObject({
      name: 'QueuedOfflineError',
      reason: 'server',
    });
    // The message is what a screen would show, and on full bars "you are back
    // on a network" contradicts the banner that is deliberately not showing.
    await expect(held(new ApiConnectionError('unavailable', 'unavailable'))).rejects.toThrow(
      /has not taken it yet/,
    );
    expect(await queued()).toHaveLength(1);
  });

  it('holds a timeout, wording it by the device rather than guessing', async () => {
    const timeout = () => new ApiConnectionError('did not respond in time', 'timeout');

    useNetworkStore.setState({ isOnline: false });
    await expect(held(timeout())).rejects.toMatchObject({ reason: 'offline' });

    useNetworkStore.setState({ isOnline: true });
    await expect(held(timeout())).rejects.toMatchObject({ reason: 'server' });

    // One target, so the second replaced the first rather than stacking.
    expect(await queued()).toHaveLength(1);
  });

  it('still does not queue a 4xx', async () => {
    await expect(held(new Error('TexasRenters API request failed (400).'))).rejects.not.toBeInstanceOf(
      QueuedOfflineError,
    );
    expect(await queued()).toHaveLength(0);
  });

  it('returns the value untouched when the write lands', async () => {
    await expect(queueOnConnectionFailure(entry, async () => ({ ok: true }))).resolves.toEqual({
      ok: true,
    });
    expect(await queued()).toHaveLength(0);
  });
});

describe('replaying what is held', () => {
  const note = (id: string) => ({ id, kind: 'room-note', payload: { roomId: id, note: 'x' } });

  /**
   * A refusal is not a delivery failure. Left in place it would sit at the
   * head of the queue and stall every entry behind it for the eight
   * reconnects it takes to burn the attempt ceiling — a technician's held
   * skips going nowhere because one submission was already in.
   */
  it('drops a write the server refused and carries on down the queue', async () => {
    await enqueueMutation(note('room-1'));
    await enqueueMutation(note('room-2'));
    const tried: string[] = [];

    const result = await drainOfflineWrites(async (path) => {
      tried.push(path);
      if (path.includes('room-1')) throw new Error('TexasRenters API request failed (409).');
      return undefined;
    });

    expect(tried).toHaveLength(2);
    expect(result).toEqual({ sent: 1, remaining: 0 });
    expect(await queued()).toHaveLength(0);
  });

  /**
   * A connection failure still stops the pass: the usual reason is that the
   * network went away again, and working through the rest only spends their
   * attempts against a connection that is gone.
   */
  it('keeps a write the network could not deliver, and stops there', async () => {
    await enqueueMutation(note('room-1'));
    await enqueueMutation(note('room-2'));
    const tried: string[] = [];

    const result = await drainOfflineWrites(async (path) => {
      tried.push(path);
      throw new ApiConnectionError('cannot connect', 'transport');
    });

    expect(tried).toHaveLength(1);
    expect(result).toEqual({ sent: 0, remaining: 2 });
    expect((await queued())[0]!.attempts).toBe(1);
  });

  /**
   * A 500 on replay is kept rather than dropped: there is no technician
   * watching a drain, so giving up would destroy the work silently. It is
   * bounded instead — outlasting a bad deploy is worth the attempts, and the
   * ceiling ends it either way.
   */
  it('keeps retrying a 500 on replay, but only to the attempt ceiling', async () => {
    await enqueueMutation(note('room-1'));

    for (let pass = 0; pass < QUEUE_ENTRY_MAX_ATTEMPTS; pass += 1) {
      await drainOfflineWrites(async () => {
        throw new ApiConnectionError('request failed (500)', 'fault');
      });
    }

    expect(await queued()).toHaveLength(0);
  });

  it('retries everything by default, for a caller with no view of its errors', async () => {
    await enqueueMutation(note('room-1'));
    await enqueueMutation(note('room-2'));
    const tried: string[] = [];

    await drainQueue(async (item) => {
      tried.push(item.id);
      throw new Error('anything');
    });

    expect(tried).toEqual(['room-1']);
    expect(await queued()).toHaveLength(2);
  });
});
