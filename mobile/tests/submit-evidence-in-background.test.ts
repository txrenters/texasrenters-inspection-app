import { ApiConnectionError } from '../src/storage/offline-record-cache';
import {
  QueuedOfflineError,
  drainOfflineWrites,
  savedRoomCompletions,
  sendSavedFirst,
  withCompletionsSaved,
} from '../src/repositories/api/offline-writes';

/**
 * Submit Evidence goes back on the tap (the office, 2026-09-30: "when I click
 * the submit, it should not wait on the server, it should work on the
 * background"). The area's photographs and its completion are sent behind the
 * technician, saved first, and every read says submitted meanwhile.
 */

// Prefixed `mock` so jest permits the hoisted factory below to reference it.
const mockStore = new Map<string, string>();
const mockFlushed: string[] = [];

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
  flushRoomSnapshotsNow: async (roomId: string) => {
    mockFlushed.push(roomId);
  },
}));

const entry = { id: 'complete:kitchen', kind: 'room-complete', payload: { roomId: 'kitchen' } };
const room = (id: string, completionStatus: string) => ({ id, completionStatus });

beforeEach(() => {
  mockStore.clear();
  mockFlushed.length = 0;
});

describe('an area submitted without waiting', () => {
  it('reads as submitted while the server has not been told, whatever the server says', async () => {
    let reply: (value: unknown) => void = () => undefined;
    void sendSavedFirst(entry, () => new Promise((resolve) => (reply = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const saved = await savedRoomCompletions();
    expect(saved).toEqual(new Set(['kitchen']));
    expect(withCompletionsSaved([room('kitchen', 'IN_PROGRESS'), room('bath', 'NOT_STARTED')], saved)).toEqual([
      room('kitchen', 'COMPLETED'),
      room('bath', 'NOT_STARTED'),
    ]);
    reply({});
  });

  it('never overrides an area the server has skipped', () => {
    expect(withCompletionsSaved([room('kitchen', 'SKIPPED')], new Set(['kitchen']))).toEqual([
      room('kitchen', 'SKIPPED'),
    ]);
  });

  it('stays saved with no signal, so the area stays submitted', async () => {
    await expect(
      sendSavedFirst(entry, async () => {
        throw new ApiConnectionError('cannot connect', 'transport');
      }),
    ).rejects.toBeInstanceOf(QueuedOfflineError);
    expect(await savedRoomCompletions()).toEqual(new Set(['kitchen']));
  });

  it('is sent later with the area’s photographs first', async () => {
    await expect(
      sendSavedFirst(entry, async () => {
        throw new ApiConnectionError('cannot connect', 'transport');
      }),
    ).rejects.toBeInstanceOf(QueuedOfflineError);

    const sent: string[] = [];
    await drainOfflineWrites(async (path) => {
      sent.push(path);
    });

    expect(mockFlushed).toEqual(['kitchen']);
    expect(sent).toEqual(['/api/v1/technician/rooms/kitchen/complete']);
    expect(await savedRoomCompletions()).toEqual(new Set());
  });

  it('is dropped when the server refuses it, so the area reads as it really is', async () => {
    await expect(
      sendSavedFirst(entry, async () => {
        throw new Error('Record or photograph this area before submitting it.');
      }),
    ).rejects.toThrow('Record or photograph');
    expect(await savedRoomCompletions()).toEqual(new Set());
  });
});
