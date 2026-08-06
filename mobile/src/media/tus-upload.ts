import { File } from 'expo-file-system';

/**
 * A minimal tus client, sized for one job: sending a local recording to a
 * Cloudflare Stream upload URL, resumably.
 *
 * Written rather than installed. `tus-js-client` is built around the browser
 * `File`/`Blob` types and cannot read a React Native `file://` URI; the native
 * RN tus modules are unavailable in Expo Go. The protocol used here is three
 * headers and two verbs, and `expo-file-system` ships inside the SDK, so this
 * runs anywhere the app does and adds no dependency.
 *
 * Deliberately isolated from the queue: this moves bytes and reports offsets,
 * and knows nothing about inspections, retries or persistence.
 */

const TUS_VERSION = '1.0.0';

/**
 * Cloudflare rejects any chunk but the last whose length is not a multiple of
 * 256 KiB, so every size this module uses is aligned to it.
 */
export const CHUNK_ALIGNMENT = 256 * 1024;
export const DEFAULT_CHUNK_BYTES = 10 * 1024 * 1024;
export const CONSTRAINED_CHUNK_BYTES = 5 * 1024 * 1024;

export function alignChunkSize(bytes: number) {
  const aligned = Math.floor(bytes / CHUNK_ALIGNMENT) * CHUNK_ALIGNMENT;
  return Math.max(CHUNK_ALIGNMENT, aligned);
}

/**
 * Why an upload stopped, in the only two categories the queue cares about.
 *
 * `permanent` means retrying the same upload URL will fail the same way —
 * usually an expired or unknown session — and the queue must ask the backend
 * for a replacement rather than looping. Anything else is worth another attempt
 * later, which is the normal case on a phone.
 */
export class TusUploadError extends Error {
  constructor(
    message: string,
    readonly kind: 'retryable' | 'permanent',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TusUploadError';
  }
}

export interface TusProgress {
  uploadedBytes: number;
  totalBytes: number;
}

/**
 * Ask the server how much it actually has.
 *
 * The server's offset is authoritative — never the value the device last
 * managed to persist. A phone killed mid-PATCH may have had bytes accepted it
 * never recorded, and trusting local state would re-send them or, worse, skip
 * them and corrupt the file.
 */
export async function fetchUploadOffset(
  uploadUrl: string,
  signal?: AbortSignal,
): Promise<number> {
  const response = await request(uploadUrl, { method: 'HEAD', signal });
  if (response.status === 404 || response.status === 410 || response.status === 403)
    throw new TusUploadError('Upload session is no longer valid.', 'permanent', response.status);
  if (!response.ok)
    throw new TusUploadError(`Could not read upload offset (${response.status}).`, 'retryable', response.status);
  const offset = Number(response.headers.get('upload-offset'));
  if (!Number.isFinite(offset) || offset < 0)
    throw new TusUploadError('Server did not report a usable offset.', 'retryable');
  return offset;
}

/**
 * Send a local file to an existing tus upload URL, resuming from wherever the
 * server already is.
 *
 * Returns the final confirmed offset. Chunks are read straight from disk one at
 * a time — a walkthrough can be hundreds of megabytes, and holding it in memory
 * on a mid-range phone is how an upload becomes a crash.
 */
export async function uploadFileInChunks(options: {
  uploadUrl: string;
  localUri: string;
  chunkBytes?: number;
  signal?: AbortSignal;
  onProgress?: (progress: TusProgress) => void;
}): Promise<number> {
  const file = new File(options.localUri);
  if (!file.exists)
    // Permanent by nature: no amount of waiting brings a deleted recording back,
    // and the queue must stop rather than retry forever.
    throw new TusUploadError('The local recording no longer exists.', 'permanent');

  const totalBytes = file.size ?? 0;
  if (totalBytes <= 0) throw new TusUploadError('The local recording is empty.', 'permanent');

  const chunkBytes = alignChunkSize(options.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  let offset = await fetchUploadOffset(options.uploadUrl, options.signal);
  options.onProgress?.({ uploadedBytes: offset, totalBytes });

  const handle = file.open();
  try {
    while (offset < totalBytes) {
      if (options.signal?.aborted)
        throw new TusUploadError('Upload was paused.', 'retryable');

      handle.offset = offset;
      const chunk = handle.readBytes(Math.min(chunkBytes, totalBytes - offset));
      if (chunk.length === 0)
        throw new TusUploadError('Read no bytes from the recording.', 'retryable');

      const response = await request(options.uploadUrl, {
        method: 'PATCH',
        signal: options.signal,
        headers: {
          'Upload-Offset': String(offset),
          'Content-Type': 'application/offset+octet-stream',
        },
        body: chunk as unknown as BodyInit,
      });

      if (response.status === 409 || response.status === 460) {
        // The server disagrees about where we are. Re-reading its offset is the
        // correct recovery and costs one request; restarting from zero would
        // throw away everything already accepted.
        offset = await fetchUploadOffset(options.uploadUrl, options.signal);
        options.onProgress?.({ uploadedBytes: offset, totalBytes });
        continue;
      }
      if (response.status === 404 || response.status === 410 || response.status === 403)
        throw new TusUploadError(
          'Upload session expired before it finished.',
          'permanent',
          response.status,
        );
      if (!response.ok)
        throw new TusUploadError(
          `Chunk rejected (${response.status}).`,
          // 4xx other than the ones above means this request will keep being
          // rejected; 5xx is the server having a bad moment.
          response.status >= 400 && response.status < 500 ? 'permanent' : 'retryable',
          response.status,
        );

      const confirmed = Number(response.headers.get('upload-offset'));
      // Only ever advance to what the server confirms. Assuming our own
      // arithmetic is what silently corrupts a resumed upload.
      offset = Number.isFinite(confirmed) && confirmed > offset ? confirmed : offset + chunk.length;
      options.onProgress?.({ uploadedBytes: offset, totalBytes });
    }
  } finally {
    handle.close();
  }
  return offset;
}

async function request(url: string, init: RequestInit & { headers?: Record<string, string> }) {
  try {
    return await fetch(url, {
      ...init,
      headers: { 'Tus-Resumable': TUS_VERSION, ...(init.headers ?? {}) },
    });
  } catch (error) {
    // No signal, a dropped connection, or a paused upload all land here. All are
    // worth another attempt once the phone has a network again.
    if ((error as { name?: string }).name === 'AbortError')
      throw new TusUploadError('Upload was paused.', 'retryable');
    throw new TusUploadError('The upload could not reach Cloudflare.', 'retryable');
  }
}
