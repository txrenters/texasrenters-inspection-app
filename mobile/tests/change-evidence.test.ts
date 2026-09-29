import type { RoomSnapshot } from '../src/domain/models';
import {
  jobStartEntryId,
  savedRoomStates,
  sendSavedFirst,
  withRoomStatesSaved,
} from '../src/repositories/api/offline-writes';
import { enqueueMutation, readQueue, removeMutation } from '../src/storage/mutation-queue';
import { useDemoStore } from '../src/stores/demo.store';
import { replaceOldEvidence } from '../src/media/replace-evidence';

/**
 * Change Evidence (the office, 2026-09-30): a submitted area goes back to work
 * "as if the first time we are doing the inspection", and "if I use the photo
 * or upload from gallery, the old evidence should be removed and be replace
 * with the new ones".
 */

// Prefixed `mock` so jest permits the hoisted factories below to reference them.
const mockStore = new Map<string, string>();
const mockReplaced: { roomId: string; photoKeys: readonly string[]; photoIds: readonly string[] }[] = [];
const mockDeletedFiles: string[] = [];

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

jest.mock('../src/repositories', () => ({
  repositories: {
    inspections: {
      replaceRoomEvidence: async (roomId: string, photoKeys: readonly string[], photoIds: readonly string[]) => {
        mockReplaced.push({ roomId, photoKeys, photoIds });
      },
    },
  },
}));

jest.mock('../src/media/local-snapshots', () => ({
  deleteRoomSnapshot: (uri: string) => {
    mockDeletedFiles.push(uri);
  },
}));

const snapshot = (id: string, roomId: string): RoomSnapshot =>
  ({ id, roomId, inspectionId: 'job-1', uri: `file:///snapshots/${id}.jpg`, uploadStatus: 'UPLOADED' }) as RoomSnapshot;
const room = (id: string, completionStatus: string) => ({ id, completionStatus });

beforeEach(() => {
  mockStore.clear();
  mockReplaced.length = 0;
  mockDeletedFiles.length = 0;
  useDemoStore.setState({ snapshots: [], evidenceToReplace: {} });
});

describe('an area reopened by Change Evidence', () => {
  it('reads as not submitted while the server has not been told', async () => {
    await enqueueMutation({ id: 'reopen:kitchen', kind: 'room-reopen', payload: { roomId: 'kitchen' } });

    const states = await savedRoomStates();
    expect(withRoomStatesSaved([room('kitchen', 'COMPLETED')], states)).toEqual([room('kitchen', 'NOT_STARTED')]);
  });

  it('follows the order the technician acted in: submitted, reopened, submitted again', async () => {
    await enqueueMutation({ id: 'complete:kitchen', kind: 'room-complete', payload: { roomId: 'kitchen' } });
    await enqueueMutation({ id: 'reopen:kitchen', kind: 'room-reopen', payload: { roomId: 'kitchen' } });
    expect((await savedRoomStates()).get('kitchen')).toBe('REOPENED');

    // Saved again under the same id: it moves to the end, after the reopen.
    await enqueueMutation({ id: 'complete:kitchen', kind: 'room-complete', payload: { roomId: 'kitchen' } });
    expect((await savedRoomStates()).get('kitchen')).toBe('COMPLETED');
    expect((await readQueue()).map((entry) => entry.kind)).toEqual(['room-reopen', 'room-complete']);
  });
});

describe('a reply removes only the copy it answered', () => {
  it('keeps a newer copy saved under the same id while the first was out', async () => {
    let reply: (value: unknown) => void = () => undefined;
    const first = sendSavedFirst(
      { id: 'complete:kitchen', kind: 'room-complete', payload: { roomId: 'kitchen' } },
      () => new Promise((resolve) => (reply = resolve)),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Reopened and submitted again with no signal: a new copy of the same write.
    await enqueueMutation({ id: 'complete:kitchen', kind: 'room-complete', payload: { roomId: 'kitchen', again: true } });

    reply({});
    await first;
    expect((await readQueue()).map((entry) => entry.payload)).toEqual([{ roomId: 'kitchen', again: true }]);
  });

  it('still removes by id alone when no copy is named', async () => {
    await enqueueMutation({ id: jobStartEntryId('job-1'), kind: 'job-start', payload: { inspectionId: 'job-1' } });
    await removeMutation(jobStartEntryId('job-1'));
    expect(await readQueue()).toEqual([]);
  });
});

describe('the new evidence replacing the old', () => {
  it('drops the marked photographs and asks the server to remove them, once', () => {
    useDemoStore.setState({
      snapshots: [snapshot('old-1', 'kitchen'), snapshot('old-2', 'kitchen'), snapshot('new-1', 'kitchen')],
      evidenceToReplace: { kitchen: { photoKeys: ['old-1', 'old-2'], photoIds: ['server-9'] } },
    });

    replaceOldEvidence('kitchen');
    replaceOldEvidence('kitchen');

    expect(useDemoStore.getState().snapshots.map((item) => item.id)).toEqual(['new-1']);
    expect(mockDeletedFiles).toEqual(['file:///snapshots/old-1.jpg', 'file:///snapshots/old-2.jpg']);
    expect(mockReplaced).toEqual([{ roomId: 'kitchen', photoKeys: ['old-1', 'old-2'], photoIds: ['server-9'] }]);
    expect(useDemoStore.getState().evidenceToReplace.kitchen).toBeUndefined();
  });

  it('does nothing to an area nobody reopened', () => {
    useDemoStore.setState({ snapshots: [snapshot('kept', 'bath')] });

    replaceOldEvidence('bath');

    expect(useDemoStore.getState().snapshots.map((item) => item.id)).toEqual(['kept']);
    expect(mockReplaced).toEqual([]);
  });
});
