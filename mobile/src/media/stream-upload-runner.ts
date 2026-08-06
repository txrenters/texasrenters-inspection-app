import type { UploadItem } from '../domain/models';
import {
  CONSTRAINED_CHUNK_BYTES,
  DEFAULT_CHUNK_BYTES,
  TusUploadError,
  uploadFileInChunks,
} from './tus-upload';

/**
 * Sends one queued recording straight to Cloudflare Stream.
 *
 * Slots into the existing upload runner rather than replacing it: that worker
 * already owns durability, retry scheduling and the in-flight mutex, and a
 * second queue beside it would drift until the two disagreed about what had
 * been sent. This only changes where the bytes go.
 */

export interface StreamUploadSession {
  videoId: string;
  streamUid: string;
  uploadUrl: string | null;
  expiresAt: string | null;
  chunkPolicy: { minimumBytes: number; preferredBytes: number };
}

export type StreamUploadOutcome =
  /** Cloudflare has the whole file. */
  | { kind: 'uploaded'; videoId: string; streamUid: string }
  /** No Stream credentials on this deployment — the caller keeps its old path. */
  | { kind: 'unavailable' }
  | { kind: 'failed'; retryable: boolean; message: string };

/**
 * Whether a stored upload URL is still worth using.
 *
 * A minute of headroom, so a URL does not lapse midway through a chunk that was
 * fine when it started.
 */
export function uploadUrlUsable(item: Pick<UploadItem, 'uploadUrl' | 'uploadUrlExpiresAt'>, now = Date.now()) {
  if (!item.uploadUrl) return false;
  if (!item.uploadUrlExpiresAt) return true;
  return new Date(item.uploadUrlExpiresAt).getTime() - 60_000 > now;
}

/**
 * Smaller chunks on a connection that keeps dropping.
 *
 * Not for throughput — chunk size does not make a link faster. A failed 10 MiB
 * chunk costs 10 MiB of re-sending, so on a link that fails often the smaller
 * unit simply loses less each time.
 */
export function chunkSizeFor(options: { unstable: boolean }) {
  return options.unstable ? CONSTRAINED_CHUNK_BYTES : DEFAULT_CHUNK_BYTES;
}

export async function runStreamUpload(options: {
  item: UploadItem;
  localUri: string;
  fileSize: number;
  mimeType: string;
  filename: string;
  unstableConnection?: boolean;
  signal?: AbortSignal;
  /** Asks the backend for a session; resolves null when Stream is unconfigured. */
  createSession: () => Promise<StreamUploadSession | null>;
  /** Persists resume state after every confirmed chunk. */
  persist: (patch: Partial<UploadItem>) => void;
}): Promise<StreamUploadOutcome> {
  let session: StreamUploadSession | null = null;

  if (uploadUrlUsable(options.item) && options.item.streamUid && options.item.serverVideoId) {
    // Resume against the session already held. Asking for a new one would mint
    // a second Cloudflare video for a recording that is half sent.
    session = {
      videoId: options.item.serverVideoId,
      streamUid: options.item.streamUid,
      uploadUrl: options.item.uploadUrl!,
      expiresAt: options.item.uploadUrlExpiresAt ?? null,
      chunkPolicy: { minimumBytes: CONSTRAINED_CHUNK_BYTES, preferredBytes: DEFAULT_CHUNK_BYTES },
    };
  } else {
    try {
      session = await options.createSession();
    } catch (error) {
      return {
        kind: 'failed',
        retryable: true,
        message: error instanceof Error ? error.message : 'Could not start the upload.',
      };
    }
    // Null means this deployment has no Cloudflare credentials. Not a failure:
    // the caller falls back to the path it used before Stream existed, so video
    // capture keeps working while the account is being set up.
    if (!session) return { kind: 'unavailable' };
    options.persist({
      serverVideoId: session.videoId,
      streamUid: session.streamUid,
      uploadUrl: session.uploadUrl ?? undefined,
      uploadUrlExpiresAt: session.expiresAt ?? undefined,
      fileSize: options.fileSize,
    });
  }

  if (!session.uploadUrl)
    // A session with no URL means the backend recognised the recording but had
    // nothing new to hand out; the existing URL must have been consumed.
    return { kind: 'failed', retryable: true, message: 'No upload URL was available.' };

  try {
    await uploadFileInChunks({
      uploadUrl: session.uploadUrl,
      localUri: options.localUri,
      chunkBytes: chunkSizeFor({ unstable: Boolean(options.unstableConnection) }),
      signal: options.signal,
      onProgress: ({ uploadedBytes, totalBytes }) => {
        // Written after every confirmed chunk, because the interesting failures
        // — a force-quit, the OS reclaiming the app — leave no chance to save
        // afterwards.
        options.persist({
          uploadedBytes,
          fileSize: totalBytes,
          progress: totalBytes > 0 ? Math.min(100, Math.floor((uploadedBytes / totalBytes) * 100)) : 0,
        });
      },
    });
  } catch (error) {
    if (error instanceof TusUploadError) {
      // A dead session must not be retried against the same URL. Clearing it
      // makes the next attempt ask for a replacement while keeping the queue
      // entry, its file, and its progress.
      if (error.kind === 'permanent')
        options.persist({ uploadUrl: undefined, uploadUrlExpiresAt: undefined });
      return { kind: 'failed', retryable: error.kind === 'retryable', message: error.message };
    }
    return {
      kind: 'failed',
      retryable: true,
      message: error instanceof Error ? error.message : 'The upload did not complete.',
    };
  }

  return { kind: 'uploaded', videoId: session.videoId, streamUid: session.streamUid };
}
