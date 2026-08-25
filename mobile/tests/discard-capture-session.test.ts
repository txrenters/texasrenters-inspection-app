import type { RoomSnapshot } from '../src/domain/models';
import {
  discardCaptureSession,
  snapshotsForSession,
  uploadedServerPhotoIds,
} from '../src/media/discard-capture-session';

const mockRequestJson = jest.fn();
const mockDeleteRoomSnapshot = jest.fn();

// Factories rather than the real modules: the repositories barrel drags in the
// whole API client, and nothing here is testing HTTP.
//
// Declared below the import on purpose — babel hoists jest.mock above it, and
// the factories only close over the spies rather than calling them, so the
// const initialisers have run long before any test does.
jest.mock('../src/repositories/api/repositories', () => ({
  requestJson: (...args: unknown[]) => mockRequestJson(...args),
}));
jest.mock('../src/media/local-snapshots', () => ({
  deleteRoomSnapshot: (...args: unknown[]) => mockDeleteRoomSnapshot(...args),
}));

function snapshot(overrides: Partial<RoomSnapshot> & { id: string }): RoomSnapshot {
  return {
    inspectionId: 'insp-1',
    roomId: 'room-1',
    uri: 'file:///inspection-snapshots/insp-1/room-1/snapshot-1.jpg',
    width: 100,
    height: 100,
    capturedAt: '2026-08-25T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockRequestJson.mockReset().mockResolvedValue(undefined);
  mockDeleteRoomSnapshot.mockReset();
});

describe('finding a take’s photographs', () => {
  const snapshots = [
    snapshot({ id: 'a', recordingSessionId: 'session-1' }),
    snapshot({ id: 'b', recordingSessionId: 'session-2' }),
    snapshot({ id: 'c', recordingSessionId: 'session-1' }),
    snapshot({ id: 'd' }),
  ];

  it('takes only the ones shot during that session', () => {
    expect(snapshotsForSession(snapshots, 'session-1').map((item) => item.id)).toEqual(['a', 'c']);
  });

  it('matches nothing when the take has no session id', () => {
    // Falling back to room would take the photographs of a take that was
    // already saved, which is a worse bug than the one being fixed.
    expect(snapshotsForSession(snapshots, undefined)).toEqual([]);
  });

  it('lists only the photographs the server already holds', () => {
    expect(
      uploadedServerPhotoIds([
        snapshot({ id: 'a', serverPhotoId: 'remote-a' }),
        snapshot({ id: 'b' }),
        snapshot({ id: 'c', serverPhotoId: 'remote-c' }),
      ]),
    ).toEqual(['remote-a', 'remote-c']);
  });
});

describe('discarding a take', () => {
  it('deletes the uploaded copies and then the local files', async () => {
    const result = await discardCaptureSession(
      [
        snapshot({ id: 'a', recordingSessionId: 's1', serverPhotoId: 'remote-a' }),
        snapshot({ id: 'b', recordingSessionId: 's1' }),
        snapshot({ id: 'other', recordingSessionId: 's2', serverPhotoId: 'remote-other' }),
      ],
      's1',
    );

    expect(mockRequestJson).toHaveBeenCalledTimes(1);
    expect(mockRequestJson).toHaveBeenCalledWith('/api/v1/technician/photos/remote-a', {
      method: 'DELETE',
    });
    expect(mockDeleteRoomSnapshot).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ removedIds: ['a', 'b'], failed: [] });
  });

  it('changes nothing locally when the server refuses', async () => {
    // The important one. Dropping the local copy would take `serverPhotoId`
    // with it, stranding a photograph on the server that nothing can find and
    // that is still bound for the report.
    mockRequestJson.mockRejectedValueOnce(new Error('offline'));

    const result = await discardCaptureSession(
      [snapshot({ id: 'a', recordingSessionId: 's1', serverPhotoId: 'remote-a' })],
      's1',
    );

    expect(result).toEqual({ removedIds: [], failed: ['remote-a'] });
    expect(mockDeleteRoomSnapshot).not.toHaveBeenCalled();
  });

  it('does nothing when the take produced no photographs', async () => {
    const result = await discardCaptureSession([snapshot({ id: 'a' })], 's1');

    expect(mockRequestJson).not.toHaveBeenCalled();
    expect(mockDeleteRoomSnapshot).not.toHaveBeenCalled();
    expect(result).toEqual({ removedIds: [], failed: [] });
  });
});
