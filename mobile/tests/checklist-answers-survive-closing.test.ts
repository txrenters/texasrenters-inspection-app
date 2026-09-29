import { ApiConnectionError } from '../src/storage/offline-record-cache';
import {
  QueuedOfflineError,
  drainOfflineWrites,
  savedChecklistAnswers,
  sendSavedFirst,
} from '../src/repositories/api/offline-writes';

/**
 * An answered checklist row is still answered after leaving the screen or
 * closing the app (the office, 2026-09-30: answered rows "are gone" on coming
 * back). The answer is saved before it is sent, and the list is read back with
 * every saved answer laid over it.
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

jest.mock('../src/media/room-snapshot-flush', () => ({ flushRoomSnapshotsNow: async () => undefined }));

const answer = (itemId: string, isClean: boolean) => ({
  id: `checklist:filters:${itemId}`,
  kind: 'checklist-assessment',
  payload: {
    roomId: 'filters',
    itemId,
    isClean,
    isUndamaged: null,
    isWorking: null,
    comment: null,
    numericValue: null,
    textValue: null,
    videoTimestampSeconds: null,
  },
});

beforeEach(() => mockStore.clear());

describe('a checklist answer the app was closed on', () => {
  it('is still answered when the checklist is read again', async () => {
    // Closed while the request was out: saved, never answered.
    let never: (value: unknown) => void = () => undefined;
    void sendSavedFirst(answer('filter-a', true), () => new Promise((resolve) => (never = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    void never;

    const saved = await savedChecklistAnswers('filters');
    expect(saved.get('filter-a')).toMatchObject({ isClean: true });
    // Only that area's.
    expect((await savedChecklistAnswers('attic')).size).toBe(0);
  });

  it('keeps only the last answer for a row, as it will be sent', async () => {
    await expect(
      sendSavedFirst(answer('filter-a', true), async () => {
        throw new ApiConnectionError('cannot connect', 'transport');
      }),
    ).rejects.toBeInstanceOf(QueuedOfflineError);
    await expect(
      sendSavedFirst(answer('filter-a', false), async () => {
        throw new ApiConnectionError('cannot connect', 'transport');
      }),
    ).rejects.toBeInstanceOf(QueuedOfflineError);

    expect((await savedChecklistAnswers('filters')).get('filter-a')).toMatchObject({ isClean: false });
  });

  it('is sent when the signal comes back, and is then the server’s to show', async () => {
    await expect(
      sendSavedFirst(answer('filter-a', true), async () => {
        throw new ApiConnectionError('cannot connect', 'transport');
      }),
    ).rejects.toBeInstanceOf(QueuedOfflineError);

    const sent: unknown[] = [];
    await drainOfflineWrites(async (path, method, body) => {
      sent.push({ path, method, body });
    });

    expect(sent).toEqual([
      expect.objectContaining({
        path: '/api/v1/technician/rooms/filters/checklist/filter-a',
        method: 'PUT',
        body: expect.objectContaining({ isClean: true }),
      }),
    ]);
    expect((await savedChecklistAnswers('filters')).size).toBe(0);
  });
});
