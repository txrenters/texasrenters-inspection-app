import type { RoomSnapshot } from '../src/domain/models';
import {
  MAX_AUTOMATIC_ATTEMPTS,
  flushRoomSnapshots,
  reviewWindowEnd,
} from '../src/media/snapshot-upload';

const mockUploadRoomPhoto = jest.fn();
jest.mock('../src/media/photo-upload', () => ({
  uploadRoomPhoto: (...args: unknown[]) => mockUploadRoomPhoto(...args),
  PhotoUploadError: class PhotoUploadError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  },
}));

function snapshot(overrides: Partial<RoomSnapshot> & { id: string }): RoomSnapshot {
  return {
    inspectionId: 'insp-1',
    roomId: 'room-1',
    uri: 'file:///snapshot.jpg',
    width: 100,
    height: 100,
    capturedAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
}

function port() {
  const update = jest.fn();
  return { store: { update }, update };
}

beforeEach(() => {
  mockUploadRoomPhoto.mockReset();
  mockUploadRoomPhoto.mockResolvedValue({ id: 'server-photo' });
});

/**
 * Completing an area is a stronger statement than the fifteen-second review
 * hold is waiting for, so submitting ends the hold rather than waiting it out.
 * Before this, `completeRoom` was answered `409 ROOM_EVIDENCE_REQUIRED` for the
 * first fifteen seconds after the shutter — the server counts uploaded photos,
 * and the only one existed on the handset by design.
 */
describe('flushing an area before it is completed', () => {
  it('sends a photograph still inside its review window', async () => {
    const { store } = port();
    await flushRoomSnapshots(
      'room-1',
      [snapshot({ id: 'held', nextAttemptAt: reviewWindowEnd() })],
      store,
    );
    expect(mockUploadRoomPhoto).toHaveBeenCalledTimes(1);
  });

  it('leaves other areas alone', async () => {
    const { store } = port();
    await flushRoomSnapshots(
      'room-1',
      [snapshot({ id: 'mine' }), snapshot({ id: 'theirs', roomId: 'room-2' })],
      store,
    );
    expect(mockUploadRoomPhoto).toHaveBeenCalledTimes(1);
    expect(mockUploadRoomPhoto.mock.calls[0][0]).toMatchObject({ idempotencyKey: 'mine' });
  });

  it('does not re-send what the server already has', async () => {
    const { store } = port();
    await flushRoomSnapshots('room-1', [snapshot({ id: 'sent', uploadStatus: 'UPLOADED' })], store);
    expect(mockUploadRoomPhoto).not.toHaveBeenCalled();
  });

  /**
   * The hold is the only rule waived. A photograph the server has refused
   * outright is recorded as FAILED with no `nextAttemptAt`, and submitting an
   * area must not turn that into a request loop.
   */
  it('does not retry a refusal the server will only repeat', async () => {
    const { store } = port();
    await flushRoomSnapshots(
      'room-1',
      [snapshot({ id: 'refused', uploadStatus: 'FAILED', nextAttemptAt: undefined })],
      store,
    );
    expect(mockUploadRoomPhoto).not.toHaveBeenCalled();
  });

  it('does not retry one that has spent its attempts', async () => {
    const { store } = port();
    await flushRoomSnapshots(
      'room-1',
      [snapshot({ id: 'spent', attempts: MAX_AUTOMATIC_ATTEMPTS })],
      store,
    );
    expect(mockUploadRoomPhoto).not.toHaveBeenCalled();
  });

  /**
   * A failure here is recorded and left in the queue rather than thrown: the
   * caller is `completeRoom`, and an upload that did not go is the offline case
   * the queued completion exists to handle.
   */
  it('records a failure without throwing', async () => {
    const { store, update } = port();
    mockUploadRoomPhoto.mockRejectedValue(new Error('no signal'));
    await expect(
      flushRoomSnapshots('room-1', [snapshot({ id: 'stuck' })], store),
    ).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledWith('stuck', expect.objectContaining({ uploadStatus: 'FAILED' }));
  });
});
