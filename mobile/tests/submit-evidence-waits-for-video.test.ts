import { ApiConnectionError, ApiRefusalError } from '../src/storage/offline-record-cache';
import {
  QueuedOfflineError,
  RecordingStillUploadingError,
  classifyWriteFailure,
  completionWaitsForRecording,
  drainOfflineWrites,
  savedRoomCompletions,
  sendSavedFirst,
} from '../src/repositories/api/offline-writes';
import { enqueueMutation, readQueue } from '../src/storage/mutation-queue';

/**
 * Submit Evidence on an area whose video is still uploading.
 *
 * The button opens while the walkthrough is only queued -- "queued counts as
 * settled", so nobody is held in a property on a transfer -- and the server
 * takes the completion only once the video has arrived. The submission was
 * refused, put back and alerted: "A confirmed uploaded video is required before
 * completing this room" (the error log, 2026-10-01: one technician, five times
 * in half an hour). It is held now, like a submission with no signal, and sent
 * when the upload finishes.
 */

// Prefixed `mock` so jest permits the hoisted factories below to reference them.
const mockStore = new Map<string, string>();
const mockUploading = new Set<string>();

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

jest.mock('../src/media/room-recording-upload', () => ({
  roomRecordingStillUploading: (roomId: string) => mockUploading.has(roomId),
}));

beforeEach(() => {
  mockStore.clear();
  mockUploading.clear();
});

const videoRequired = () =>
  new ApiRefusalError('A confirmed uploaded video is required before completing this room.', 409, 'ROOM_VIDEO_REQUIRED');
const complete = (roomId: string) => ({
  id: `complete:${roomId}`,
  kind: 'room-complete',
  payload: { roomId },
});
const completePath = (roomId: string) => `/api/v1/technician/rooms/${roomId}/complete`;

describe('a refused completion, while the area’s video is uploading', () => {
  it('is only early when the server asked for the evidence and this phone is still sending it', () => {
    mockUploading.add('kitchen');

    expect(completionWaitsForRecording(videoRequired(), 'kitchen')).toBe(true);
    expect(
      completionWaitsForRecording(new ApiRefusalError('Photograph this room…', 409, 'ROOM_EVIDENCE_REQUIRED'), 'kitchen'),
    ).toBe(true);
    // Nothing on its way here: a real refusal, shown as before.
    expect(completionWaitsForRecording(videoRequired(), 'bath')).toBe(false);
    // Any other refusal stands, whatever the upload is doing.
    expect(
      completionWaitsForRecording(new ApiRefusalError('This job has been submitted.', 409, 'AREA_NOT_REOPENABLE'), 'kitchen'),
    ).toBe(false);
    expect(completionWaitsForRecording(new Error('A confirmed uploaded video is required'), 'kitchen')).toBe(false);
  });

  it('is held for the upload, not failed, and the area stays submitted', async () => {
    expect(classifyWriteFailure(new RecordingStillUploadingError(), true)).toEqual({
      hold: true,
      reason: 'upload',
    });

    const outcome = sendSavedFirst(complete('kitchen'), async () => {
      throw new RecordingStillUploadingError();
    });

    await expect(outcome).rejects.toBeInstanceOf(QueuedOfflineError);
    await expect(outcome).rejects.toMatchObject({ reason: 'upload' });
    expect(await savedRoomCompletions()).toEqual(new Set(['kitchen']));
  });
});

describe('draining a submission that waits for its video', () => {
  it('passes it over without spending an attempt, and sends everything else', async () => {
    mockUploading.add('kitchen');
    await enqueueMutation(complete('kitchen'));
    await enqueueMutation(complete('bath'));

    const sent: string[] = [];
    await drainOfflineWrites(async (path) => {
      sent.push(path);
      if (path === completePath('kitchen')) throw videoRequired();
    });

    expect(sent).toEqual([completePath('kitchen'), completePath('bath')]);
    const left = await readQueue();
    expect(left.map((entry) => entry.id)).toEqual(['complete:kitchen']);
    expect(left[0]!.attempts).toBe(0);
  });

  it('holds what follows for the same area behind it, so Change Evidence is not sent first', async () => {
    mockUploading.add('kitchen');
    await enqueueMutation(complete('kitchen'));
    await enqueueMutation({ id: 'reopen:kitchen', kind: 'room-reopen', payload: { roomId: 'kitchen' } });

    const sent: string[] = [];
    await drainOfflineWrites(async (path) => {
      sent.push(path);
      if (path === completePath('kitchen')) throw videoRequired();
    });

    expect(sent).toEqual([completePath('kitchen')]);
    expect((await readQueue()).map((entry) => entry.id)).toEqual(['complete:kitchen', 'reopen:kitchen']);
  });

  it('is sent once the upload has finished', async () => {
    await enqueueMutation(complete('kitchen'));

    const sent: string[] = [];
    await drainOfflineWrites(async (path) => {
      sent.push(path);
    });

    expect(sent).toEqual([completePath('kitchen')]);
    expect(await readQueue()).toEqual([]);
  });

  it('is dropped when the server refuses it with nothing on its way, as any refusal is', async () => {
    // The upload failed, or there never was one: waiting would wait for good.
    await enqueueMutation(complete('kitchen'));

    await drainOfflineWrites(async () => {
      throw videoRequired();
    });

    expect(await readQueue()).toEqual([]);
  });

  it('still stops at a lost connection, as it always did', async () => {
    await enqueueMutation(complete('kitchen'));
    await enqueueMutation(complete('bath'));

    const sent: string[] = [];
    await drainOfflineWrites(async (path) => {
      sent.push(path);
      throw new ApiConnectionError('cannot connect', 'transport');
    });

    expect(sent).toEqual([completePath('kitchen')]);
    expect((await readQueue()).map((entry) => [entry.id, entry.attempts])).toEqual([
      ['complete:kitchen', 1],
      ['complete:bath', 0],
    ]);
  });

  it('runs one pass at a time, so two callers never send an entry twice', async () => {
    await enqueueMutation(complete('kitchen'));

    const sent: string[] = [];
    const send = async (path: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      sent.push(path);
    };
    await Promise.all([drainOfflineWrites(send), drainOfflineWrites(send)]);

    expect(sent).toEqual([completePath('kitchen')]);
  });
});
