import type { UploadItem } from '../src/domain/models';
import { ApiInspectionRepository } from '../src/repositories/api/repositories';
import { useDemoStore } from '../src/stores/demo.store';
import { useNetworkStore } from '../src/stores/network.store';

/**
 * End job with room videos still on this phone (2026-11-14).
 *
 * A technician used to wait out every upload, with the app open, before End job
 * went through. Now the job is sent with the videos still on their way named,
 * and the server waits for them. The server waits only for a video it knows --
 * one whose upload was opened -- so End job opens the uploads the queue has not
 * reached yet, and keeps each on its queue item as the queue would. Everything
 * invented.
 */

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
jest.mock('../src/auth/session', () => ({
  getSession: async () => ({ accessToken: 'token', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 }),
  signedInUserId: async () => 'tech-1',
  SessionExpiredError: class SessionExpiredError extends Error {},
}));
jest.mock('../src/config/environment', () => ({
  environment: { apiBaseUrl: 'https://api.test', apiBaseUrls: ['https://api.test'] },
}));
jest.mock('expo-file-system/legacy', () => ({
  ...jest.requireActual('expo-file-system/legacy'),
  getInfoAsync: async () => ({ exists: true, size: 12_000_000 }),
}));
jest.mock('../src/media/room-snapshot-flush', () => ({ flushRoomSnapshotsNow: async () => undefined }));

const TECHNICIAN = 'tech-1';

const upload = (n: number, patch: Partial<UploadItem> = {}): UploadItem =>
  ({
    id: `local-upload-local-media-${n}`,
    ownerUserId: TECHNICIAN,
    mediaId: `local-media-${n}`,
    inspectionId: 'job-1',
    roomId: `area-${n}`,
    recordingType: 'PRIMARY_AREA',
    propertyAddress: '1 Test St',
    roomName: `Room ${n}`,
    durationSeconds: 60,
    estimatedSizeMb: 12,
    status: 'PENDING',
    progress: 0,
    processingStatus: 'NOT_STARTED',
    processingProgress: 0,
    createdAt: new Date().toISOString(),
    ...patch,
  }) as UploadItem;

const media = (n: number) => ({
  id: `local-media-${n}`,
  uri: `file:///recordings/${n}.mp4`,
  durationSeconds: 60,
  recordedAt: '2026-11-14T15:00:00.000Z',
});

const submitted = {
  id: 'job-1',
  externalInspectionId: 'PW-1',
  propertyId: 'prop-1',
  type: 'MOVE_OUT',
  scheduledAt: '2026-11-14T00:00:00.000Z',
  assignedUserId: TECHNICIAN,
  status: 'TECHNICIAN_SUBMITTED',
  priority: 'STANDARD',
  roomIds: [],
  propertyNotes: '',
  property: { id: 'prop-1', address: '1 Test St', cityStateZip: 'Austin, TX 78701', imageTone: 'teal' },
  progress: { completed: 3, total: 5, hasFailedUpload: false },
};

/** The server, as a list of what it was asked; `refuseField` plays a server from before late videos. */
function server(options: { refuseField?: boolean } = {}) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url: String(url), body });
    const reply = (status: number, payload: unknown) => ({
      ok: status < 300,
      status,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    });
    if (String(url).endsWith('/inspection-videos/upload-session'))
      return reply(201, {
        videoId: `video-for-${body?.idempotencyKey}`,
        streamUid: `uid-for-${body?.idempotencyKey}`,
        uploadUrl: 'https://upload.test/tus/abc',
        uploaded: false,
        uploadProtocol: 'tus',
        expiresAt: new Date(Date.now() + 3_000_000).toISOString(),
        chunkPolicy: { minimumBytes: 5_242_880, preferredBytes: 10_485_760 },
      });
    if (String(url).endsWith('/complete')) {
      if (options.refuseField && body && 'videosStillSending' in body)
        return reply(400, { message: 'property videosStillSending should not exist', code: 'VALIDATION_FAILED' });
      return reply(200, submitted);
    }
    return reply(200, []);
  }) as never;
  return calls;
}

beforeEach(() => {
  mockStore.clear();
  useNetworkStore.setState({ isOnline: true, isResolved: true });
  useDemoStore.setState({ selectedUserId: TECHNICIAN, uploads: [], media: [] } as never);
});

describe('End job with videos still on the phone', () => {
  it('opens an upload for each the queue has not reached, keeps it on the item, and names them all', async () => {
    useDemoStore.setState({
      uploads: [
        // Opened already, by the queue.
        upload(1, { serverVideoId: 'video-1', streamUid: 'uid-1', uploadUrl: 'https://upload.test/tus/1' }),
        // Not reached yet: no upload opened.
        upload(2),
        // Held by Low Power Mode.
        upload(3, { status: 'PAUSED' }),
        // Sent, and failed: not waited for here.
        upload(4, { status: 'COMPLETED' }),
        upload(5, { status: 'FAILED' }),
        // Another job's.
        upload(6, { inspectionId: 'job-2' }),
      ],
      media: [media(1), media(2), media(3), media(4), media(5), media(6)],
    } as never);
    const calls = server();

    await new ApiInspectionRepository().complete('job-1');

    const opened = calls.filter((call) => call.url.endsWith('/upload-session')).map((call) => call.body?.idempotencyKey);
    expect(opened).toEqual(['local-media-2', 'local-media-3']);
    const ended = calls.find((call) => call.url.endsWith('/complete'));
    expect(ended?.body).toEqual({ videosStillSending: ['local-media-1', 'local-media-2', 'local-media-3'] });
    // Kept as the queue keeps an upload, so it goes on to send it without asking again.
    expect(useDemoStore.getState().uploads.find((item) => item.id === 'local-upload-local-media-2')).toMatchObject({
      serverVideoId: 'video-for-local-media-2',
      streamUid: 'uid-for-local-media-2',
      uploadUrl: 'https://upload.test/tus/abc',
    });
  });

  it('sends nothing new when no video is still on its way', async () => {
    useDemoStore.setState({ uploads: [upload(1, { status: 'COMPLETED' })], media: [media(1)] } as never);
    const calls = server();

    await new ApiInspectionRepository().complete('job-1');

    expect(calls.some((call) => call.url.endsWith('/upload-session'))).toBe(false);
    expect(calls.find((call) => call.url.endsWith('/complete'))?.body).toBeNull();
  });

  it('asks a server from before late videos once more without them', async () => {
    useDemoStore.setState({
      uploads: [upload(1, { serverVideoId: 'video-1', streamUid: 'uid-1' })],
      media: [media(1)],
    } as never);
    const calls = server({ refuseField: true });

    await new ApiInspectionRepository().complete('job-1');

    const ends = calls.filter((call) => call.url.endsWith('/complete'));
    expect(ends.map((call) => call.body)).toEqual([{ videosStillSending: ['local-media-1'] }, null]);
  });
});
