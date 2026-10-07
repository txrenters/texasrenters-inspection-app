import { TusUploadError, uploadFileInChunks } from '../src/media/tus-upload';
import { WHOLE_FILE_MAX_BYTES, type WholeFileSender } from '../src/media/whole-file-upload';

/**
 * A recording sent to Cloudflare in one request by the platform (2026-10-07).
 *
 * The chunked path read every 10 MiB of a walkthrough into JavaScript, and on
 * an iPhone stopped whenever the phone locked. A fresh recording that fits one
 * request now goes through the operating system's own uploader instead, and
 * whatever it cannot finish is picked up in chunks from Cloudflare's offset.
 */

// Prefixed `mock` so jest permits the hoisted factory below to reference them.
const mockFile = { exists: true, size: 0, open: jest.fn() };

jest.mock('expo-file-system', () => ({
  File: jest.fn(() => mockFile),
}));

const originalFetch = global.fetch;
const URL = 'https://upload.cloudflarestream.com/tus/abc';

function respond(status: number, headers: Record<string, string> = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers) };
}

/** Cloudflare's tus endpoint: answers HEAD with `offset`, and counts the chunks sent. */
function cloudflare(offset: () => number) {
  const chunks: number[] = [];
  global.fetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === 'HEAD') return Promise.resolve(respond(200, { 'upload-offset': String(offset()) }));
    chunks.push(Number((init.headers as Record<string, string>)['Upload-Offset']));
    return Promise.resolve(respond(204, { 'upload-offset': String(mockFile.size) }));
  }) as never;
  return chunks;
}

function handleOver(totalBytes: number) {
  return {
    offset: 0 as number | null,
    readBytes(length: number) {
      return new Uint8Array(Math.max(0, Math.min(length, totalBytes - (this.offset ?? 0))));
    },
    close() {},
  };
}

beforeEach(() => {
  mockFile.exists = true;
  mockFile.size = 30 * 1024 * 1024;
  mockFile.open.mockReset().mockReturnValue(handleOver(mockFile.size));
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe('a fresh recording that fits one request', () => {
  it('goes to Cloudflare whole, through the platform, without a byte read into JavaScript', async () => {
    const chunks = cloudflare(() => 0);
    const wholeFile = jest.fn<ReturnType<WholeFileSender>, Parameters<WholeFileSender>>(async () => ({
      status: 204,
      headers: { 'Upload-Offset': String(mockFile.size) },
    }));

    const final = await uploadFileInChunks({ uploadUrl: URL, localUri: 'file:///take.mp4', wholeFile });

    expect(final).toBe(mockFile.size);
    expect(wholeFile).toHaveBeenCalledTimes(1);
    expect(wholeFile.mock.calls[0]?.[0]).toMatchObject({
      url: URL,
      localUri: 'file:///take.mp4',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': '0',
        'Content-Type': 'application/offset+octet-stream',
      },
    });
    expect(chunks).toEqual([]);
    expect(mockFile.open).not.toHaveBeenCalled();
  });

  it('is not started during a take, or while videos are held', async () => {
    cloudflare(() => 0);
    const wholeFile = jest.fn();

    await expect(
      uploadFileInChunks({ uploadUrl: URL, localUri: 'file:///take.mp4', wholeFile, shouldPause: () => true }),
    ).rejects.toMatchObject({ kind: 'retryable', message: 'Upload was paused.' });
    expect(wholeFile).not.toHaveBeenCalled();
  });

  it('is let finish once started, whatever the camera does meanwhile', async () => {
    cloudflare(() => 0);
    let filming = false;
    const wholeFile: WholeFileSender = async () => {
      filming = true; // the next room's take starts mid-upload
      return { status: 204, headers: { 'upload-offset': String(mockFile.size) } };
    };

    await expect(
      uploadFileInChunks({ uploadUrl: URL, localUri: 'file:///take.mp4', wholeFile, shouldPause: () => filming }),
    ).resolves.toBe(mockFile.size);
  });

  it('passes progress on every two seconds, not on every packet the platform reports', async () => {
    cloudflare(() => 0);
    const progress: number[] = [];
    const wholeFile: WholeFileSender = async ({ onProgress }) => {
      for (let sent = 1; sent <= 500; sent += 1) onProgress(sent * 1024);
      return { status: 204, headers: { 'upload-offset': String(mockFile.size) } };
    };

    await uploadFileInChunks({
      uploadUrl: URL,
      localUri: 'file:///take.mp4',
      wholeFile,
      onProgress: ({ uploadedBytes }) => progress.push(uploadedBytes),
    });

    // The starting offset, one packet, and the confirmed end.
    expect(progress).toEqual([0, 1024, mockFile.size]);
  });
});

describe('what the platform could not finish', () => {
  it('is carried on in chunks from where Cloudflare says it got to', async () => {
    let atCloudflare = 0;
    const chunks = cloudflare(() => atCloudflare);
    const wholeFile: WholeFileSender = async () => {
      atCloudflare = 20 * 1024 * 1024;
      return { status: 413, headers: {} };
    };

    await expect(uploadFileInChunks({ uploadUrl: URL, localUri: 'file:///take.mp4', wholeFile })).resolves.toBe(
      mockFile.size,
    );
    expect(chunks[0]).toBe(20 * 1024 * 1024);
  });

  it('asks Cloudflare when the answer does not say how much arrived', async () => {
    const chunks = cloudflare(() => mockFile.size);
    let first = true;
    global.fetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      if (init.method === 'HEAD') {
        const offset = first ? 0 : mockFile.size;
        first = false;
        return Promise.resolve(respond(200, { 'upload-offset': String(offset) }));
      }
      return Promise.resolve(respond(204));
    }) as never;

    await expect(
      uploadFileInChunks({
        uploadUrl: URL,
        localUri: 'file:///take.mp4',
        wholeFile: async () => ({ status: 204, headers: {} }),
      }),
    ).resolves.toBe(mockFile.size);
    expect(chunks).toEqual([]);
  });

  it('is retried later when the connection was lost, naming the host', async () => {
    cloudflare(() => 0);
    const failure = uploadFileInChunks({
      uploadUrl: URL,
      localUri: 'file:///take.mp4',
      wholeFile: async () => {
        throw new Error('The network connection was lost.');
      },
    });
    await expect(failure).rejects.toBeInstanceOf(TusUploadError);
    await expect(failure).rejects.toMatchObject({
      kind: 'retryable',
      message: 'The upload could not reach upload.cloudflarestream.com (The network connection was lost.).',
    });
  });

  it('asks for a new link when the one it had is dead', async () => {
    cloudflare(() => 0);
    await expect(
      uploadFileInChunks({
        uploadUrl: URL,
        localUri: 'file:///take.mp4',
        wholeFile: async () => ({ status: 404, headers: {} }),
      }),
    ).rejects.toMatchObject({ kind: 'permanent', status: 404 });
  });
});

describe('a recording the platform does not send whole', () => {
  it('keeps the chunked path when Cloudflare already has part of it', async () => {
    const chunks = cloudflare(() => 10 * 1024 * 1024);
    const wholeFile = jest.fn();

    await uploadFileInChunks({ uploadUrl: URL, localUri: 'file:///take.mp4', wholeFile });

    expect(wholeFile).not.toHaveBeenCalled();
    expect(chunks[0]).toBe(10 * 1024 * 1024);
  });

  it('keeps the chunked path when the take is longer than one request may carry', async () => {
    mockFile.size = WHOLE_FILE_MAX_BYTES + 1;
    mockFile.open.mockReturnValue(handleOver(mockFile.size));
    const chunks = cloudflare(() => 0);
    const wholeFile = jest.fn();

    await uploadFileInChunks({ uploadUrl: URL, localUri: 'file:///take.mp4', wholeFile });

    expect(wholeFile).not.toHaveBeenCalled();
    expect(chunks[0]).toBe(0);
  });
});
