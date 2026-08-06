import type { UploadItem } from '../src/domain/models';
import {
  chunkSizeFor,
  runStreamUpload,
  uploadUrlUsable,
  type StreamUploadSession,
} from '../src/media/stream-upload-runner';
import { CONSTRAINED_CHUNK_BYTES, DEFAULT_CHUNK_BYTES, TusUploadError } from '../src/media/tus-upload';

// Prefixed `mock` so jest permits the hoisted factory below to reference it.
const mockUpload = jest.fn();

jest.mock('../src/media/tus-upload', () => {
  const actual = jest.requireActual('../src/media/tus-upload');
  return { ...actual, uploadFileInChunks: (...args: unknown[]) => mockUpload(...args) };
});

const item = (patch: Partial<UploadItem> = {}): UploadItem =>
  ({
    id: 'upload-1',
    mediaId: 'media-1',
    inspectionId: 'insp-1',
    roomId: 'area-1',
    propertyAddress: '1 Test St',
    roomName: 'Kitchen',
    durationSeconds: 90,
    estimatedSizeMb: 12,
    status: 'PENDING',
    progress: 0,
    processingStatus: 'NOT_STARTED',
    processingProgress: 0,
    createdAt: '2026-08-06T00:00:00.000Z',
    ...patch,
  }) as UploadItem;

const session: StreamUploadSession = {
  videoId: 'video-1',
  streamUid: 'uid-1',
  uploadUrl: 'https://upload.cloudflarestream.com/tus/abc',
  expiresAt: new Date(Date.now() + 3_000_000).toISOString(),
  chunkPolicy: { minimumBytes: 5_242_880, preferredBytes: 10_485_760 },
};

function run(overrides: Parameters<typeof runStreamUpload>[0] extends infer T ? Partial<T> : never) {
  const persisted: Partial<UploadItem>[] = [];
  const options = {
    item: item(),
    localUri: 'file:///a.mp4',
    fileSize: 12_000_000,
    mimeType: 'video/mp4',
    filename: 'kitchen.mp4',
    createSession: jest.fn().mockResolvedValue(session),
    persist: (patch: Partial<UploadItem>) => persisted.push(patch),
    ...overrides,
  } as Parameters<typeof runStreamUpload>[0];
  return { promise: runStreamUpload(options), persisted, options };
}

beforeEach(() => {
  mockUpload.mockReset();
  mockUpload.mockResolvedValue(12_000_000);
});

describe('chunk sizing', () => {
  it('drops to a smaller unit on an unstable link', () => {
    // Not for speed — chunk size does not make a link faster. A failed 10 MiB
    // chunk costs 10 MiB of re-sending, so a flaky link loses less per failure.
    expect(chunkSizeFor({ unstable: true })).toBe(CONSTRAINED_CHUNK_BYTES);
    expect(chunkSizeFor({ unstable: false })).toBe(DEFAULT_CHUNK_BYTES);
  });
});

describe('falling back when Stream is not configured', () => {
  it('reports unavailable rather than failing the recording', async () => {
    // A deployment with no Cloudflare credentials must keep capturing video
    // through the path it used before Stream existed.
    const { promise } = run({ createSession: jest.fn().mockResolvedValue(null) });
    await expect(promise).resolves.toEqual({ kind: 'unavailable' });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('treats a session error as retryable, not as a downgrade', async () => {
    // A technician standing in a unit needs the upload retried; silently
    // falling back would hide a real backend fault.
    const { promise } = run({
      createSession: jest.fn().mockRejectedValue(new Error('gateway timeout')),
    });
    await expect(promise).resolves.toMatchObject({ kind: 'failed', retryable: true });
  });
});

describe('session reuse', () => {
  it('resumes against the session it already holds', async () => {
    // Asking for a new session would mint a second Cloudflare video for a
    // recording that is half sent.
    const createSession = jest.fn();
    const { promise } = run({
      item: item({
        streamUid: 'uid-1',
        serverVideoId: 'video-1',
        uploadUrl: 'https://upload/existing',
        uploadUrlExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        uploadedBytes: 5_000_000,
      }),
      createSession,
    });
    await promise;
    expect(createSession).not.toHaveBeenCalled();
    expect(mockUpload.mock.calls[0][0].uploadUrl).toBe('https://upload/existing');
  });

  it('requests a new session once the held URL is near expiry', async () => {
    const createSession = jest.fn().mockResolvedValue(session);
    const { promise } = run({
      item: item({
        streamUid: 'uid-1',
        serverVideoId: 'video-1',
        uploadUrl: 'https://upload/old',
        uploadUrlExpiresAt: new Date(Date.now() + 10_000).toISOString(),
      }),
      createSession,
    });
    await promise;
    expect(createSession).toHaveBeenCalled();
  });

  it('persists the session so a restart can resume', async () => {
    const { promise, persisted } = run({});
    await promise;
    expect(persisted[0]).toMatchObject({
      serverVideoId: 'video-1',
      streamUid: 'uid-1',
      uploadUrl: session.uploadUrl,
    });
  });
});

describe('progress and failure', () => {
  it('persists confirmed bytes as it goes', async () => {
    // The interesting failures — a force-quit, the OS reclaiming the app —
    // leave no chance to save afterwards.
    mockUpload.mockImplementation(async (options: { onProgress: (p: unknown) => void }) => {
      options.onProgress({ uploadedBytes: 6_000_000, totalBytes: 12_000_000 });
      return 12_000_000;
    });
    const { promise, persisted } = run({});
    await promise;
    expect(persisted).toContainEqual(
      expect.objectContaining({ uploadedBytes: 6_000_000, progress: 50 }),
    );
  });

  it('clears a dead upload URL so the next attempt asks for a new one', async () => {
    // Retrying an expired session against the same URL fails identically
    // forever; the queue entry, its file and its progress all survive.
    mockUpload.mockRejectedValue(new TusUploadError('expired', 'permanent', 404));
    const { promise, persisted } = run({
      item: item({
        streamUid: 'uid-1',
        serverVideoId: 'video-1',
        uploadUrl: 'https://upload/old',
        uploadUrlExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    });
    await expect(promise).resolves.toMatchObject({ kind: 'failed', retryable: false });
    expect(persisted).toContainEqual({ uploadUrl: undefined, uploadUrlExpiresAt: undefined });
  });

  it('keeps a lost connection retryable', async () => {
    mockUpload.mockRejectedValue(new TusUploadError('offline', 'retryable'));
    const { promise } = run({});
    await expect(promise).resolves.toMatchObject({ kind: 'failed', retryable: true });
  });

  it('reports the video ids on success', async () => {
    const { promise } = run({});
    await expect(promise).resolves.toEqual({
      kind: 'uploaded',
      videoId: 'video-1',
      streamUid: 'uid-1',
    });
  });
});

describe('upload URL freshness', () => {
  it('keeps headroom so a URL cannot lapse mid-chunk', () => {
    const now = 1_000_000;
    expect(
      uploadUrlUsable({ uploadUrl: 'u', uploadUrlExpiresAt: new Date(now + 30_000).toISOString() }, now),
    ).toBe(false);
    expect(
      uploadUrlUsable({ uploadUrl: 'u', uploadUrlExpiresAt: new Date(now + 600_000).toISOString() }, now),
    ).toBe(true);
  });

  it('treats a missing URL as unusable', () => {
    expect(uploadUrlUsable({ uploadUrl: undefined, uploadUrlExpiresAt: undefined })).toBe(false);
  });
});
