import { AppState } from 'react-native';

import {
  MAX_RECORDING_BYTES,
  MAX_RECORDING_SECONDS,
  RECORDING_VIDEO_BITRATE,
  stoppedBySizeLimit,
} from '../src/capture/recording-limit';
import type { UploadItem } from '../src/domain/models';
import { setCaptureActive } from '../src/media/capture-activity';
import { UPLOAD_LINK_EXPIRED_MESSAGE } from '../src/media/stream-upload-runner';
import { TusUploadError, type UploadPath } from '../src/media/tus-upload';
import { uploadPlan } from '../src/media/upload-slots';
import { WHOLE_FILE_MAX_BYTES } from '../src/media/whole-file-upload';
import { ApiUploadRepository } from '../src/repositories/api/repositories';
import { useDemoStore } from '../src/stores/demo.store';

/**
 * Room videos, smaller and sent sooner (the office, 2026-11-13: slow video
 * uploads were holding up its work, and a move-in or move-out cannot be
 * submitted until every video has arrived).
 *
 * A take is filmed at 2.5 Mbps and stopped at 195 MiB, so every one fits the
 * phone's own background uploader. That uploader may start while the next room
 * is filmed, and two recordings may go at once. The chunked path, the one that
 * runs JavaScript, is as it was: alone, between takes.
 */

const mockSends: {
  options: { shouldPause?: (path: UploadPath) => boolean; wholeFile?: unknown };
  finish: () => void;
  fail: (error: unknown) => void;
}[] = [];
const mockSizes = new Map<string, number>();

jest.mock('../src/media/tus-upload', () => {
  const actual = jest.requireActual('../src/media/tus-upload');
  return {
    ...actual,
    uploadFileInChunks: (options: (typeof mockSends)[number]['options']) =>
      new Promise((resolve, reject) => {
        mockSends.push({ options, finish: () => resolve(undefined), fail: reject });
      }),
  };
});
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: async (uri: string) => ({ exists: true, size: mockSizes.get(uri) ?? 0 }),
  // The platform's uploader, as `nativeWholeFileSender` reaches for it; the
  // sends above stand in for it, so it is never called.
  createUploadTask: () => {
    throw new Error('not reached');
  },
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
  FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
}));
jest.mock('../src/auth/session', () => ({
  getSession: async () => ({ accessToken: 'token' }),
  SessionExpiredError: class SessionExpiredError extends Error {},
}));
jest.mock('../src/config/environment', () => ({
  environment: { apiBaseUrl: 'https://api.test', apiBaseUrls: ['https://api.test'] },
}));

const TECHNICIAN = 'tech-1';
const MiB = 1024 * 1024;

/** A room's recording in the queue, with the upload link its session already gave it. */
function queued(room: string, patch: Partial<UploadItem> = {}, sizeBytes = 20 * MiB): UploadItem {
  const uri = `file:///recordings/${room}.mp4`;
  mockSizes.set(uri, sizeBytes);
  const media = { id: `media-${room}`, uri, durationSeconds: 60, recordedAt: new Date().toISOString() };
  useDemoStore.setState((state) => ({ media: [...state.media, media as never] }));
  return {
    id: `local-upload-${room}`,
    ownerUserId: TECHNICIAN,
    mediaId: media.id,
    inspectionId: 'insp-1',
    roomId: `area-${room}`,
    recordingType: 'PRIMARY_AREA',
    propertyAddress: '1 Test St',
    roomName: room,
    durationSeconds: 60,
    estimatedSizeMb: sizeBytes / MiB,
    status: 'PENDING',
    progress: 0,
    processingStatus: 'NOT_STARTED',
    processingProgress: 0,
    createdAt: new Date().toISOString(),
    serverVideoId: `video-${room}`,
    streamUid: `uid-${room}`,
    uploadUrl: `https://upload.cloudflarestream.com/tus/${room}`,
    uploadUrlExpiresAt: new Date(Date.now() + 50 * 60_000).toISOString(),
    ...patch,
  } as UploadItem;
}

function inQueue(...items: UploadItem[]) {
  useDemoStore.setState({ uploads: items });
}

const upload = (id: string) => useDemoStore.getState().uploads.find((item) => item.id === `local-upload-${id}`);

/** Lets the ticks reach the uploader, which they do after reading the file. */
async function settle() {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const originalAppState = AppState.currentState;

beforeEach(() => {
  mockSends.length = 0;
  mockSizes.clear();
  useDemoStore.setState({ selectedUserId: TECHNICIAN, uploads: [], media: [] });
});
afterEach(async () => {
  // Nothing left holding a place in the queue for the next test.
  mockSends.forEach((send) => send.finish());
  await settle();
  setCaptureActive(false);
  (AppState as { currentState: unknown }).currentState = originalAppState;
});

describe('a take', () => {
  it('is filmed at 2.5 Mbps, about 19.5 MB a minute with the sound', () => {
    expect(RECORDING_VIDEO_BITRATE).toBe(2_500_000);
    const bytesPerMinute = ((RECORDING_VIDEO_BITRATE + 128_000) / 8) * 60;
    expect(bytesPerMinute / 1_000_000).toBeCloseTo(19.7, 1);
  });

  it('fits the platform uploader at the ten-minute limit, even with generous sound', () => {
    const tenMinutes = ((RECORDING_VIDEO_BITRATE + 192_000) / 8) * MAX_RECORDING_SECONDS;
    expect(tenMinutes).toBeLessThan(MAX_RECORDING_BYTES);
    // Room for the file's index after the camera stops it.
    expect(MAX_RECORDING_BYTES).toBeLessThanOrEqual(WHOLE_FILE_MAX_BYTES - 4 * MiB);
  });

  it('is told apart when the size cap, not the technician, ended it', () => {
    expect(stoppedBySizeLimit(MAX_RECORDING_BYTES - MiB, false)).toBe(true);
    expect(stoppedBySizeLimit(MAX_RECORDING_BYTES - MiB, true)).toBe(false);
    expect(stoppedBySizeLimit(40 * MiB, false)).toBe(false);
    expect(stoppedBySizeLimit(undefined, false)).toBe(false);
  });
});

describe('which way a queued recording goes', () => {
  it('goes whole, beside others, when it is fresh and fits one request', () => {
    expect(uploadPlan({ sizeBytes: 60 * MiB }, true)).toEqual({ path: 'whole-file', alone: false });
    expect(uploadPlan({ sizeBytes: WHOLE_FILE_MAX_BYTES, uploadedBytes: 0 }, true).path).toBe('whole-file');
  });

  it('goes in chunks, alone, when Cloudflare has part of it, when it is too large, or with no uploader', () => {
    expect(uploadPlan({ sizeBytes: 60 * MiB, uploadedBytes: 10 * MiB }, true)).toEqual({ path: 'chunks', alone: true });
    expect(uploadPlan({ sizeBytes: WHOLE_FILE_MAX_BYTES + 1 }, true)).toEqual({ path: 'chunks', alone: true });
    expect(uploadPlan({ sizeBytes: 60 * MiB }, false)).toEqual({ path: 'chunks', alone: true });
    // A size nobody knows is not assumed to fit.
    expect(uploadPlan({ sizeBytes: 0 }, true).path).toBe('chunks');
  });

  it('goes alone after its upload link lapsed, so the second try has all the signal', () => {
    expect(uploadPlan({ sizeBytes: 190 * MiB, lastError: UPLOAD_LINK_EXPIRED_MESSAGE }, true)).toEqual({
      path: 'whole-file',
      alone: true,
    });
  });
});

describe('the queue while a room is being filmed', () => {
  it('hands a fresh recording to the platform, and keeps its chunks for after the take', async () => {
    inQueue(queued('kitchen'));
    setCaptureActive(true);

    const ticked = new ApiUploadRepository().tick();
    await settle();

    expect(mockSends).toHaveLength(1);
    const [send] = mockSends;
    expect(send?.options.wholeFile).toBeDefined();
    expect(send?.options.shouldPause?.('whole-file')).toBe(false);
    expect(send?.options.shouldPause?.('chunks')).toBe(true);
    expect(upload('kitchen')?.status).toBe('UPLOADING');

    send?.finish();
    await expect(ticked).resolves.toBe(true);
    expect(upload('kitchen')?.status).toBe('COMPLETED');
  });

  it('leaves a recording Cloudflare has part of until the take ends, and spends no attempt on it', async () => {
    inQueue(queued('kitchen', { uploadedBytes: 10 * MiB }));
    setCaptureActive(true);

    await expect(new ApiUploadRepository().tick()).resolves.toBe(false);

    expect(mockSends).toHaveLength(0);
    expect(upload('kitchen')).toMatchObject({ status: 'PENDING' });
    expect(upload('kitchen')?.attemptCount).toBeUndefined();
  });

  it('counts a whole file that fails mid-take as a failure, retried after its backoff rather than at once', async () => {
    inQueue(queued('kitchen'));
    setCaptureActive(true);

    const ticked = new ApiUploadRepository().tick();
    await settle();
    mockSends[0]?.fail(new TusUploadError('The upload could not reach upload.cloudflarestream.com (offline).', 'retryable'));

    await expect(ticked).resolves.toBe(true);
    const after = upload('kitchen');
    expect(after).toMatchObject({ status: 'PENDING', attemptCount: 1 });
    expect(new Date(after?.nextAttemptAt ?? 0).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('recordings side by side', () => {
  it('sends two at once, and the third waits for one of them', async () => {
    inQueue(queued('kitchen'), queued('bedroom'), queued('garage'));
    const queue = new ApiUploadRepository();

    const first = queue.tick();
    const second = queue.tick();
    await settle();

    expect(mockSends).toHaveLength(2);
    expect(upload('kitchen')?.status).toBe('UPLOADING');
    expect(upload('bedroom')?.status).toBe('UPLOADING');
    await expect(queue.tick()).resolves.toBe(false);
    expect(upload('garage')?.status).toBe('PENDING');

    mockSends[0]?.finish();
    await expect(first).resolves.toBe(true);
    const third = queue.tick();
    await settle();
    expect(upload('garage')?.status).toBe('UPLOADING');

    mockSends.forEach((send) => send.finish());
    await Promise.all([second, third]);
  });

  it('sends a recording in chunks alone: never beside another, and nothing beside it', async () => {
    inQueue(queued('garage', { uploadedBytes: 30 * MiB }, 120 * MiB), queued('kitchen'));
    const queue = new ApiUploadRepository();

    const chunked = queue.tick();
    await settle();
    expect(upload('garage')?.status).toBe('UPLOADING');
    await expect(queue.tick()).resolves.toBe(false);
    expect(upload('kitchen')?.status).toBe('PENDING');

    mockSends[0]?.finish();
    await chunked;
    const whole = queue.tick();
    await settle();
    expect(upload('kitchen')?.status).toBe('UPLOADING');
    mockSends[1]?.finish();
    await whole;
  });

  it('stops a whole file that has to finish in chunks while another is going', async () => {
    inQueue(queued('kitchen'), queued('bedroom'));
    const queue = new ApiUploadRepository();

    const ticks = [queue.tick(), queue.tick()];
    await settle();

    // Both set out whole; either one carrying on in chunks would wait.
    expect(mockSends.map((send) => send.options.shouldPause?.('chunks'))).toEqual([true, true]);
    mockSends.forEach((send) => send.finish());
    await Promise.all(ticks);
  });

  it('sends a recording whose upload link lapsed alone the next time', async () => {
    inQueue(queued('garage', { lastError: UPLOAD_LINK_EXPIRED_MESSAGE }, 190 * MiB), queued('kitchen'));
    const queue = new ApiUploadRepository();

    const retried = queue.tick();
    await settle();
    await expect(queue.tick()).resolves.toBe(false);
    expect(mockSends).toHaveLength(1);

    mockSends[0]?.finish();
    await retried;
  });
});

describe('an iPhone in the background', () => {
  it('keeps a fresh recording for the foreground, where iOS starts the transfer at once', async () => {
    inQueue(queued('kitchen'));
    (AppState as { currentState: unknown }).currentState = 'background';

    await expect(new ApiUploadRepository().tick()).resolves.toBe(false);
    expect(mockSends).toHaveLength(0);

    (AppState as { currentState: unknown }).currentState = 'active';
    const ticked = new ApiUploadRepository().tick();
    await settle();
    expect(mockSends).toHaveLength(1);
    mockSends[0]?.finish();
    await ticked;
  });
});
