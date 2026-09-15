import type { RoomSnapshot } from '../src/domain/models';
import { deviceTimeZone, frameClock, shutterClock } from '../src/media/capture-clock';
import { buildRoomSnapshot } from '../src/media/local-snapshots';
import { uploadRoomPhoto } from '../src/media/photo-upload';
import { captureTimeToSend } from '../src/media/snapshot-upload';

/**
 * Photographs are evidence a court may be shown, and the stamp on one said when
 * the server received it. These pin the phone to sending when the shutter
 * fired instead: a tap before the camera is asked for the picture, and for a
 * frame cut from an Android recording, the moment that frame shows.
 */

const mockCreateUploadTask = jest.fn();
jest.mock('expo-file-system/legacy', () => ({
  createUploadTask: (...args: unknown[]) => mockCreateUploadTask(...args),
  FileSystemUploadType: { MULTIPART: 1 },
}));
jest.mock('../src/auth/session', () => ({
  getSession: async () => ({ accessToken: 'token' }),
}));
jest.mock('../src/config/environment', () => ({
  environment: { apiBaseUrls: ['https://inspection-api.example.test'], apiBaseUrl: '' },
}));
jest.mock('../src/storage/offline-record-cache', () => ({
  SessionExpiredError: class SessionExpiredError extends Error {},
}));

const SHUTTER = Date.parse('2026-09-15T14:03:27.412Z');

function snapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    id: 'snapshot-1757944807900-abcde',
    inspectionId: 'insp-1',
    roomId: 'room-1',
    uri: 'file:///snapshot.jpg',
    width: 100,
    height: 100,
    capturedAt: '2026-09-15T14:03:27.412Z',
    ...overrides,
  };
}

describe('the moment the shutter fired', () => {
  it('is the tap, with the zone and offset of the phone that took it', () => {
    const clock = shutterClock(SHUTTER);

    expect(clock.capturedAt).toBe('2026-09-15T14:03:27.412Z');
    expect(clock.captureUtcOffsetMinutes).toBe(-new Date(SHUTTER).getTimezoneOffset() || 0);
    expect(clock.captureTimeZone).toBe(deviceTimeZone());
  });

  it('still times the photograph when the phone cannot name its zone', () => {
    const spy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new Error('Intl is not available');
    });
    try {
      expect(deviceTimeZone()).toBeUndefined();
      expect(shutterClock(SHUTTER)).toEqual({
        capturedAt: '2026-09-15T14:03:27.412Z',
        captureUtcOffsetMinutes: -new Date(SHUTTER).getTimezoneOffset() || 0,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('for a frame cut from a recording, is the recording start plus the marked offset', () => {
    // Android cannot photograph mid-recording: the shutter marks 42 s in, and the
    // frame is cut after the walkthrough ends. It shows 42 s after the start.
    expect(frameClock(SHUTTER, 42_000).capturedAt).toBe('2026-09-15T14:04:09.412Z');
  });
});

describe('a photograph built from the camera', () => {
  it('is filed under the shutter, not the moment its file was saved', () => {
    const built = buildRoomSnapshot({
      inspectionId: 'insp-1',
      roomId: 'room-1',
      uri: 'file:///snapshot.jpg',
      width: 100,
      height: 100,
      clock: { capturedAt: '2026-09-15T14:03:27.412Z', captureUtcOffsetMinutes: -300, captureTimeZone: 'America/Chicago' },
    });

    expect(built).toMatchObject({
      capturedAt: '2026-09-15T14:03:27.412Z',
      captureUtcOffsetMinutes: -300,
      captureTimeZone: 'America/Chicago',
    });
  });

  it('carries no shutter time when none was read', () => {
    const built = buildRoomSnapshot({
      inspectionId: 'insp-1',
      roomId: 'room-1',
      uri: 'file:///snapshot.jpg',
      width: 100,
      height: 100,
    });

    expect(built).not.toHaveProperty('captureUtcOffsetMinutes');
    expect(captureTimeToSend(built)).toEqual({});
  });
});

describe('what goes to the server with a photograph', () => {
  beforeEach(() => {
    mockCreateUploadTask.mockReset();
    mockCreateUploadTask.mockReturnValue({
      uploadAsync: async () => ({ status: 201, body: JSON.stringify({ id: 'server-photo' }) }),
    });
  });

  it('sends the shutter time, zone and offset of a photograph timed at the shutter', async () => {
    const timed = snapshot({ captureUtcOffsetMinutes: -300, captureTimeZone: 'America/Chicago' });

    await uploadRoomPhoto({
      roomId: timed.roomId,
      uri: timed.uri,
      captureType: 'AREA_OVERVIEW',
      idempotencyKey: timed.id,
      ...captureTimeToSend(timed),
    });

    const [, , options] = mockCreateUploadTask.mock.calls[0] as [string, string, { parameters: Record<string, string> }];
    expect(options.parameters).toMatchObject({
      capturedAt: '2026-09-15T14:03:27.412Z',
      captureTimeZone: 'America/Chicago',
      // Multipart values are strings; the server turns it back into a number.
      captureUtcOffsetMinutes: '-300',
    });
  });

  it('sends no capture time for a photograph an earlier release saved', async () => {
    // Its capturedAt is when the file was written, which is not a capture time.
    const legacy = snapshot({ captureSource: 'VIDEO_FRAME_EXTRACTION' });

    await uploadRoomPhoto({
      roomId: legacy.roomId,
      uri: legacy.uri,
      captureType: 'AREA_OVERVIEW',
      idempotencyKey: legacy.id,
      ...captureTimeToSend(legacy),
    });

    const [, , options] = mockCreateUploadTask.mock.calls[0] as [string, string, { parameters: Record<string, string> }];
    expect(options.parameters).not.toHaveProperty('capturedAt');
    expect(options.parameters).not.toHaveProperty('captureUtcOffsetMinutes');
    expect(options.parameters).not.toHaveProperty('captureTimeZone');
  });

  it('sends an offset of zero, which is a real offset', () => {
    expect(captureTimeToSend(snapshot({ captureUtcOffsetMinutes: 0, captureTimeZone: 'UTC' }))).toEqual({
      capturedAt: '2026-09-15T14:03:27.412Z',
      captureUtcOffsetMinutes: 0,
      captureTimeZone: 'UTC',
    });
  });
});
