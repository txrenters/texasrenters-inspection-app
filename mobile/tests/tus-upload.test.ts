import {
  CHUNK_ALIGNMENT,
  TusUploadError,
  alignChunkSize,
  fetchUploadOffset,
  uploadFileInChunks,
} from '../src/media/tus-upload';

// Prefixed `mock` so jest permits the hoisted factory below to reference them.
const mockFile = { exists: true, size: 0, open: jest.fn() };

jest.mock('expo-file-system', () => ({
  File: jest.fn(() => mockFile),
}));

const originalFetch = global.fetch;

/** A fake handle over an in-memory buffer, standing in for the device file. */
function handleOver(totalBytes: number) {
  const state = { offset: 0 as number | null, size: totalBytes, closed: false };
  return {
    ...state,
    readBytes(length: number) {
      const start = (this.offset ?? 0) as number;
      return new Uint8Array(Math.max(0, Math.min(length, totalBytes - start)));
    },
    close() {
      this.closed = true;
    },
  };
}

function respond(status: number, headers: Record<string, string> = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers) };
}

beforeEach(() => {
  mockFile.exists = true;
  mockFile.size = 0;
  mockFile.open.mockReset();
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('chunk sizing', () => {
  it('aligns every chunk to what Cloudflare will accept', () => {
    // Cloudflare rejects any chunk but the last whose length is not a multiple
    // of 256 KiB, so an unaligned size fails mid-upload rather than up front.
    for (const requested of [1, 5_000_000, 10_485_760, 7_777_777])
      expect(alignChunkSize(requested) % CHUNK_ALIGNMENT).toBe(0);
  });

  it('never rounds down to nothing', () => {
    expect(alignChunkSize(1)).toBe(CHUNK_ALIGNMENT);
  });
});

describe('offset discovery', () => {
  it('reads the offset the server confirms', async () => {
    global.fetch = jest.fn().mockResolvedValue(respond(200, { 'upload-offset': '7340032' })) as never;
    await expect(fetchUploadOffset('https://upload/x')).resolves.toBe(7_340_032);
  });

  it('treats a dead session as permanent so the queue asks for a new one', async () => {
    // Retrying an expired upload URL fails identically forever; the queue has
    // to know to request a replacement session instead of looping.
    for (const status of [403, 404, 410]) {
      global.fetch = jest.fn().mockResolvedValue(respond(status)) as never;
      await expect(fetchUploadOffset('https://upload/x')).rejects.toMatchObject({
        kind: 'permanent',
      });
    }
  });

  it('treats a server wobble as retryable', async () => {
    global.fetch = jest.fn().mockResolvedValue(respond(503)) as never;
    await expect(fetchUploadOffset('https://upload/x')).rejects.toMatchObject({
      kind: 'retryable',
    });
  });
});

describe('resumable upload', () => {
  it('resumes from the server offset instead of restarting', async () => {
    // The failure this whole module exists to prevent: re-sending 200 MB a
    // technician already uploaded.
    mockFile.size = 20 * 1024 * 1024;
    mockFile.open.mockReturnValue(handleOver(mockFile.size));
    const sent: number[] = [];
    global.fetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      if (init.method === 'HEAD')
        return Promise.resolve(respond(200, { 'upload-offset': String(15 * 1024 * 1024) }));
      sent.push(Number((init.headers as Record<string, string>)['Upload-Offset']));
      return Promise.resolve(respond(204, { 'upload-offset': String(mockFile.size) }));
    }) as never;

    const final = await uploadFileInChunks({
      uploadUrl: 'https://upload/x',
      localUri: 'file:///a.mp4',
    });
    expect(sent[0]).toBe(15 * 1024 * 1024);
    expect(final).toBe(mockFile.size);
  });

  it('advances only to the offset the server confirms', async () => {
    // Trusting local arithmetic is what silently corrupts a resumed upload.
    mockFile.size = 2 * CHUNK_ALIGNMENT;
    mockFile.open.mockReturnValue(handleOver(mockFile.size));
    const progress: number[] = [];
    let call = 0;
    global.fetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      if (init.method === 'HEAD') return Promise.resolve(respond(200, { 'upload-offset': '0' }));
      call += 1;
      // Server accepted less than we sent on the first chunk.
      const confirmed = call === 1 ? CHUNK_ALIGNMENT / 2 : mockFile.size;
      return Promise.resolve(respond(204, { 'upload-offset': String(confirmed) }));
    }) as never;

    await uploadFileInChunks({
      uploadUrl: 'https://upload/x',
      localUri: 'file:///a.mp4',
      chunkBytes: CHUNK_ALIGNMENT,
      onProgress: ({ uploadedBytes }) => progress.push(uploadedBytes),
    });
    expect(progress).toContain(CHUNK_ALIGNMENT / 2);
  });

  it('re-reads the offset when the server disagrees, rather than starting over', async () => {
    mockFile.size = CHUNK_ALIGNMENT;
    mockFile.open.mockReturnValue(handleOver(mockFile.size));
    let patches = 0;
    global.fetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      if (init.method === 'HEAD') return Promise.resolve(respond(200, { 'upload-offset': '0' }));
      patches += 1;
      if (patches === 1) return Promise.resolve(respond(409));
      return Promise.resolve(respond(204, { 'upload-offset': String(mockFile.size) }));
    }) as never;

    await expect(
      uploadFileInChunks({ uploadUrl: 'https://upload/x', localUri: 'file:///a.mp4' }),
    ).resolves.toBe(mockFile.size);
    expect(patches).toBe(2);
  });

  it('reports progress as it goes so the queue can persist it', async () => {
    mockFile.size = 3 * CHUNK_ALIGNMENT;
    mockFile.open.mockReturnValue(handleOver(mockFile.size));
    let offset = 0;
    global.fetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      if (init.method === 'HEAD') return Promise.resolve(respond(200, { 'upload-offset': '0' }));
      offset += CHUNK_ALIGNMENT;
      return Promise.resolve(respond(204, { 'upload-offset': String(offset) }));
    }) as never;

    const seen: number[] = [];
    await uploadFileInChunks({
      uploadUrl: 'https://upload/x',
      localUri: 'file:///a.mp4',
      chunkBytes: CHUNK_ALIGNMENT,
      onProgress: ({ uploadedBytes }) => seen.push(uploadedBytes),
    });
    expect(seen).toEqual([0, CHUNK_ALIGNMENT, 2 * CHUNK_ALIGNMENT, 3 * CHUNK_ALIGNMENT]);
  });

  it('closes the file handle even when the upload fails', async () => {
    // A leaked handle on a phone is a file that cannot be cleaned up later.
    mockFile.size = CHUNK_ALIGNMENT;
    const handle = handleOver(mockFile.size);
    mockFile.open.mockReturnValue(handle);
    global.fetch = jest.fn().mockImplementation((_url: string, init: RequestInit) =>
      init.method === 'HEAD'
        ? Promise.resolve(respond(200, { 'upload-offset': '0' }))
        : Promise.resolve(respond(500)),
    ) as never;

    await expect(
      uploadFileInChunks({ uploadUrl: 'https://upload/x', localUri: 'file:///a.mp4' }),
    ).rejects.toThrow(TusUploadError);
    expect(handle.closed).toBe(true);
  });

  it('calls a deleted recording permanent, not worth retrying', async () => {
    // No amount of waiting brings the file back; the queue must stop.
    mockFile.exists = false;
    await expect(
      uploadFileInChunks({ uploadUrl: 'https://upload/x', localUri: 'file:///gone.mp4' }),
    ).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('treats a lost connection as retryable', async () => {
    mockFile.size = CHUNK_ALIGNMENT;
    mockFile.open.mockReturnValue(handleOver(mockFile.size));
    global.fetch = jest.fn().mockRejectedValue(new Error('Network request failed')) as never;
    await expect(
      uploadFileInChunks({ uploadUrl: 'https://upload/x', localUri: 'file:///a.mp4' }),
    ).rejects.toMatchObject({ kind: 'retryable' });
  });

  it('stops without losing progress when paused', async () => {
    mockFile.size = 4 * CHUNK_ALIGNMENT;
    mockFile.open.mockReturnValue(handleOver(mockFile.size));
    const controller = new AbortController();
    let offset = 0;
    global.fetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      if (init.method === 'HEAD') return Promise.resolve(respond(200, { 'upload-offset': '0' }));
      offset += CHUNK_ALIGNMENT;
      controller.abort();
      return Promise.resolve(respond(204, { 'upload-offset': String(offset) }));
    }) as never;

    const seen: number[] = [];
    await expect(
      uploadFileInChunks({
        uploadUrl: 'https://upload/x',
        localUri: 'file:///a.mp4',
        chunkBytes: CHUNK_ALIGNMENT,
        signal: controller.signal,
        onProgress: ({ uploadedBytes }) => seen.push(uploadedBytes),
      }),
    ).rejects.toMatchObject({ kind: 'retryable' });
    // A pause is not a failure: the confirmed offset was reported before
    // stopping, so resuming continues from there.
    expect(seen[seen.length - 1]).toBe(CHUNK_ALIGNMENT);
  });
});
