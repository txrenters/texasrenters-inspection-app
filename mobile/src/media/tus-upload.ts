import { File } from 'expo-file-system';

import { headerValue, WHOLE_FILE_MAX_BYTES, type WholeFileSender } from './whole-file-upload';

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

/**
 * Whether the upload link itself is what died -- expired, unknown, or refused
 * -- as opposed to the recording or the chunk being at fault. A new link cures
 * the first; nothing automatic cures the second.
 */
export function sessionExpired(error: TusUploadError) {
  return error.kind === 'permanent' && (error.status === 404 || error.status === 410 || error.status === 403);
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
  /**
   * Asked before every chunk; true stops the upload at that boundary.
   *
   * A boundary rather than an abort, because the chunk already in flight costs
   * the phone nothing more to finish -- the bytes are in native hands -- and
   * cutting it off would only mean sending it again.
   */
  shouldPause?: () => boolean;
  onProgress?: (progress: TusProgress) => void;
  /**
   * Sends a fresh recording that fits one request through the platform's own
   * uploader instead (see `whole-file-upload`). Anything it cannot finish is
   * picked up here, in chunks, from wherever Cloudflare says it got to.
   */
  wholeFile?: WholeFileSender;
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

  if (options.wholeFile && offset === 0 && totalBytes <= WHOLE_FILE_MAX_BYTES) {
    // Not started during a take, nor while videos are held -- but once handed
    // to the platform it is let finish: it costs JavaScript nothing, and
    // stopping it would only mean sending the rest again in chunks.
    if (options.signal?.aborted || options.shouldPause?.())
      throw new TusUploadError('Upload was paused.', 'retryable');
    offset = await sendWholeFile(options.wholeFile, options.uploadUrl, options.localUri, totalBytes, options.onProgress);
    if (offset >= totalBytes) return offset;
  }

  const handle = file.open();
  try {
    while (offset < totalBytes) {
      if (options.signal?.aborted || options.shouldPause?.())
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

/** How often a whole-file upload's progress is passed on; the platform reports far more often. */
export const WHOLE_FILE_PROGRESS_MS = 2_000;

/**
 * One PATCH carrying the whole file, through the platform's uploader.
 *
 * Returns Cloudflare's offset afterwards. Only a dead upload link is thrown as
 * such; any other refusal of the one large request is answered by asking
 * Cloudflare where it is, so the chunked loop can carry on from there.
 */
async function sendWholeFile(
  send: WholeFileSender,
  uploadUrl: string,
  localUri: string,
  totalBytes: number,
  onProgress?: (progress: TusProgress) => void,
): Promise<number> {
  let reportedAt = 0;
  let response: Awaited<ReturnType<WholeFileSender>>;
  try {
    response = await send({
      url: uploadUrl,
      localUri,
      headers: {
        'Tus-Resumable': TUS_VERSION,
        'Upload-Offset': '0',
        'Content-Type': 'application/offset+octet-stream',
      },
      onProgress: (sentBytes) => {
        // Saved to the queue, and so to storage, every time it is passed on.
        const now = Date.now();
        if (now - reportedAt < WHOLE_FILE_PROGRESS_MS) return;
        reportedAt = now;
        onProgress?.({ uploadedBytes: Math.min(sentBytes, totalBytes), totalBytes });
      },
    });
  } catch (error) {
    // The platform's own timeouts end a stalled request (60 seconds without a
    // byte, on both), so this is a lost connection, worth another attempt.
    throw unreachable(uploadUrl, error);
  }
  if (!response) throw new TusUploadError('Upload was paused.', 'retryable');
  if (response.status === 404 || response.status === 410 || response.status === 403)
    throw new TusUploadError('Upload session expired before it finished.', 'permanent', response.status);

  const confirmed = Number(headerValue(response.headers, 'upload-offset'));
  const offset =
    response.status >= 200 && response.status < 300 && Number.isFinite(confirmed) && confirmed > 0
      ? confirmed
      : await fetchUploadOffset(uploadUrl);
  onProgress?.({ uploadedBytes: offset, totalBytes });
  return offset;
}

/**
 * How long one request may go unanswered before it is given up and retried.
 *
 * React Native's fetch has no timeout of its own, and on Android none at all
 * underneath it: a connection that stalls rather than drops -- a phone moving
 * from Wi-Fi to cellular mid-chunk -- leaves the request open for good. The
 * queue sends one recording at a time, so that one hung chunk held every
 * recording behind it until the app was restarted (2026-10-02).
 *
 * Generous, because a slow link is not a hung one: a full 10 MiB chunk at a
 * quarter of a megabit is about five minutes. The offset check is tiny.
 */
export const OFFSET_TIMEOUT_MS = 60_000;
export const CHUNK_TIMEOUT_MS = 6 * 60_000;

type BinaryFetch = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'headers'>>;

let binaryFetch: Promise<BinaryFetch> | null = null;

/**
 * Expo's fetch, which hands a chunk's bytes to native code as they are.
 *
 * React Native's own `fetch` cannot send binary. It turns every `Uint8Array`
 * body into a base64 string on the JavaScript thread first
 * (`convertRequestBody` → `binaryToBase64`), and native code decodes it back.
 * For a 10 MiB chunk that is millions of small strings joined into one of
 * ~14 MB, with the JS thread pinned for seconds -- and it ran while the next
 * room was being filmed. On an iPhone in Low Power Mode, with the camera's
 * buffers resident, that was the freeze and then the close the technicians
 * reported (2026-10-06).
 *
 * Loaded on first use, inside a `catch`, rather than imported at the top.
 * `ExpoFetchModule` is the `expo` package's own native module and is linked
 * into every SDK 54 binary, so this should never fall back -- but if it ever
 * did, the cost must be a slower upload, not an app that cannot start. The
 * specifier stays a literal: Metro refuses any other (see `loadKeepAwake`).
 */
function chunkFetch(): Promise<BinaryFetch> {
  binaryFetch ??= import('expo/fetch')
    .then(({ fetch: expoFetch }): BinaryFetch => (url, init) =>
      expoFetch(url, { ...init, credentials: 'omit' } as Parameters<typeof expoFetch>[1]),
    )
    .catch((): BinaryFetch => (url, init) => fetch(url, init));
  return binaryFetch;
}

async function request(
  url: string,
  init: RequestInit & { headers?: Record<string, string> },
  timeoutMs = init.method === 'PATCH' ? CHUNK_TIMEOUT_MS : OFFSET_TIMEOUT_MS,
) {
  // The caller's pause and this timeout, as one signal fetch understands.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const pause = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  init.signal?.addEventListener?.('abort', pause);
  try {
    const send = await chunkFetch();
    return await send(url, {
      ...init,
      signal: controller.signal,
      headers: { 'Tus-Resumable': TUS_VERSION, ...(init.headers ?? {}) },
    });
  } catch (error) {
    if (timedOut)
      throw new TusUploadError(
        `The upload stopped answering for ${Math.round(timeoutMs / 1000)} seconds. It will try again.`,
        'retryable',
      );
    // No signal, a dropped connection, or a paused upload all land here. All are
    // worth another attempt once the phone has a network again. Read from the
    // signal, not the error's name: Expo's fetch reports a cancelled request
    // as a plain `FetchError`, never an `AbortError`.
    if (controller.signal.aborted || (error as { name?: string }).name === 'AbortError')
      throw new TusUploadError('Upload was paused.', 'retryable');
    throw unreachable(url, error);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener?.('abort', pause);
  }
}

/**
 * Names the host and the underlying reason. "Could not reach Cloudflare" was
 * true but undiagnosable: it did not distinguish a phone with no signal from a
 * network that blocks upload.cloudflarestream.com specifically, and those need
 * different answers from whoever is helping.
 */
function unreachable(url: string, error: unknown) {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return 'Cloudflare';
    }
  })();
  const reason = error instanceof Error ? error.message : String(error);
  return new TusUploadError(`The upload could not reach ${host} (${reason}).`, 'retryable');
}
