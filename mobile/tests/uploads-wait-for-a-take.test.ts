import type { UploadItem } from '../src/domain/models';
import { setCaptureActive } from '../src/media/capture-activity';
import { ApiUploadRepository } from '../src/repositories/api/repositories';
import { useDemoStore } from '../src/stores/demo.store';

/**
 * The upload queue during a move-out (2026-10-06).
 *
 * Technicians on iPhones saw the app freeze and close mid-inspection. The
 * previous room's video was uploading while the next room was filmed, and the
 * finished upload was never handed over to the server's record of it -- so the
 * uploads list polled every five seconds for as long as the app was open.
 */

jest.mock('../src/auth/session', () => ({
  getSession: async () => ({ accessToken: 'token' }),
  SessionExpiredError: class SessionExpiredError extends Error {},
}));
jest.mock('../src/config/environment', () => ({
  environment: { apiBaseUrl: 'https://api.test', apiBaseUrls: ['https://api.test'] },
}));

const TECHNICIAN = 'tech-1';

const sent = (patch: Partial<UploadItem> = {}): UploadItem =>
  ({
    id: 'local-upload-local-media-1',
    ownerUserId: TECHNICIAN,
    mediaId: 'local-media-1',
    serverVideoId: 'video-1',
    inspectionId: 'insp-1',
    roomId: 'area-1',
    propertyAddress: '1 Test St',
    roomName: 'Kitchen',
    durationSeconds: 90,
    estimatedSizeMb: 12,
    status: 'COMPLETED',
    progress: 100,
    processingStatus: 'VIDEO_PROCESSING',
    processingProgress: 0,
    createdAt: new Date().toISOString(),
    ...patch,
  }) as UploadItem;

const serverRow = (status: 'PENDING' | 'COMPLETED') => ({
  id: 'video-1',
  mediaId: 'video-1',
  inspectionId: 'insp-1',
  roomId: 'area-1',
  propertyAddress: '1 Test St',
  roomName: 'Kitchen',
  durationSeconds: 90,
  estimatedSizeMb: 0,
  status,
  progress: status === 'COMPLETED' ? 1 : 0,
  processingStatus: 'VIDEO_PROCESSING',
  processingProgress: 0,
  createdAt: new Date().toISOString(),
});

/** A plain function, not `jest.fn()`: the preset clears mocks between tests. */
const serverLists = (rows: unknown[]) => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rows),
    json: async () => rows,
  })) as never;
};

beforeEach(() => {
  useDemoStore.setState({ selectedUserId: TECHNICIAN, uploads: [], media: [] });
});
afterEach(() => setCaptureActive(false));

describe('an upload Cloudflare has finished', () => {
  it('is listed once, not twice, while the server still waits for the encode', async () => {
    useDemoStore.setState({ uploads: [sent()] });
    serverLists([serverRow('PENDING')]);

    const list = await new ApiUploadRepository().list();

    expect(list.map((item) => item.id)).toEqual(['local-upload-local-media-1']);
    // Kept: until the webhook lands, this copy is the only one that knows the
    // bytes all arrived.
    expect(useDemoStore.getState().uploads).toHaveLength(1);
  });

  it('is handed to the server once the server has it, and leaves the device queue', async () => {
    useDemoStore.setState({ uploads: [sent()] });
    serverLists([serverRow('COMPLETED')]);

    const list = await new ApiUploadRepository().list();

    expect(list.map((item) => item.id)).toEqual(['video-1']);
    expect(useDemoStore.getState().uploads).toHaveLength(0);
  });

  it('is never handed over while it is still being sent', async () => {
    useDemoStore.setState({ uploads: [sent({ status: 'UPLOADING', progress: 40 })] });
    serverLists([serverRow('COMPLETED')]);

    await new ApiUploadRepository().list();

    expect(useDemoStore.getState().uploads).toHaveLength(1);
  });

  it('leaves the phone with the recording it came from (2026-10-06)', async () => {
    // Every walkthrough used to stay on the phone for good; a week of
    // move-outs filled it, and a full phone cannot record.
    useDemoStore.setState({
      uploads: [sent()],
      media: [{ id: 'local-media-1', uri: 'file:///recordings/kitchen.mp4' } as never],
    });
    serverLists([serverRow('COMPLETED')]);

    await new ApiUploadRepository().list();

    expect(useDemoStore.getState().media).toHaveLength(0);
  });
});

describe('the queue while a room is being filmed', () => {
  it('sends nothing, and spends no attempt on the waiting recording', async () => {
    const waiting = sent({ status: 'PENDING', progress: 0, serverVideoId: undefined });
    useDemoStore.setState({ uploads: [waiting] });
    globalThis.fetch = (async () => {
      throw new Error('nothing may be sent during a take');
    }) as never;
    setCaptureActive(true);

    await expect(new ApiUploadRepository().tick()).resolves.toBe(false);

    const [after] = useDemoStore.getState().uploads;
    expect(after).toBeDefined();
    expect(after?.status).toBe('PENDING');
    expect(after?.attemptCount).toBeUndefined();
  });
});
