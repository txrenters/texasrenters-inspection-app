import type { UploadItem } from '../domain/models';

/**
 * What one queued recording should say it is doing.
 *
 * Pure, so the wording is testable without a renderer — the important cases
 * here are the ones a technician acts on, and "does this say Uploaded before
 * the video can actually be watched" is a question worth answering in a test
 * rather than by eye.
 *
 * The transfer state and the encoding state are deliberately combined *here*
 * rather than stored combined. They are separate facts — bytes arriving and a
 * video becoming playable are different events — and only the label needs to
 * merge them.
 */
export type UploadTone = 'done' | 'active' | 'waiting' | 'idle' | 'error';

export interface UploadDescriptor {
  label: string;
  tone: UploadTone;
  /** Secondary line: bytes, retry count, or why it stopped. */
  detail: string | null;
  /** Whether the recording is still the only copy on this device. */
  localFileRetained: boolean;
  showProgressBar: boolean;
}

/**
 * Where a room recording actually is.
 *
 * The area screen used to print "stored on device" for every recording, which
 * stayed on screen long after the file had uploaded and the local copy had been
 * removed — telling a technician the opposite of the truth about where their
 * evidence lives, which is the one thing they need to be able to trust.
 *
 * `local-media-` is the id prefix the media repository already uses to mark a
 * record that exists only on this phone, so this reads the distinction the data
 * layer has always made rather than inventing a new one.
 */
export function describeRecordingLocation(recordingId: string): string {
  return recordingId.startsWith('local-media-') ? 'stored on device' : 'uploaded';
}

/** Bytes as a technician would read them, not as a machine would. */
export function formatBytes(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const megabytes = bytes / (1024 * 1024);
  if (megabytes < 1) return `${Math.round(bytes / 1024)} KB`;
  return megabytes >= 100 ? `${Math.round(megabytes)} MB` : `${megabytes.toFixed(1)} MB`;
}

/** "12.4 MB of 48.0 MB", when both numbers are actually known. */
export function formatTransferred(item: Pick<UploadItem, 'uploadedBytes' | 'fileSize'>) {
  const total = formatBytes(item.fileSize);
  if (!total) return null;
  const sent = formatBytes(item.uploadedBytes ?? 0);
  return sent ? `${sent} of ${total}` : total;
}

export function describeUpload(
  item: UploadItem,
  context: { online: boolean; now?: number },
): UploadDescriptor {
  const now = context.now ?? Date.now();
  const transferred = formatTransferred(item);
  const attempts = item.attemptCount ?? 0;

  if (item.status === 'COMPLETED') {
    // The distinction the whole screen turns on. The bytes are at Cloudflare,
    // but until encoding finishes there is nothing to watch — saying "Uploaded"
    // here sends a technician away from a property believing the evidence is
    // usable when it may still fail to encode.
    const encoding =
      item.processingStatus === 'VIDEO_PROCESSING' || item.processingStatus === 'NOT_STARTED';
    return encoding
      ? {
          label: 'Upload complete — processing video',
          tone: 'active',
          detail: 'Cloudflare is preparing it for playback.',
          // Already safely off the device; nothing here depends on the local copy.
          localFileRetained: false,
          showProgressBar: false,
        }
      : {
          label: 'Ready',
          tone: 'done',
          detail: null,
          localFileRetained: false,
          showProgressBar: false,
        };
  }

  if (item.status === 'FAILED')
    return {
      label: 'Upload failed',
      tone: 'error',
      // Never a bare "failed": the technician has to decide whether to retry
      // here or re-record, and only the reason tells them which.
      detail: item.lastError ?? 'This upload stopped and will not retry on its own.',
      localFileRetained: true,
      showProgressBar: false,
    };

  if (item.status === 'PAUSED')
    return {
      label: 'Paused',
      tone: 'idle',
      detail: transferred,
      localFileRetained: true,
      showProgressBar: true,
    };

  if (item.status === 'UPLOADING')
    return {
      label: `Uploading — ${Math.round(item.progress)}%`,
      tone: 'active',
      detail: transferred,
      localFileRetained: true,
      showProgressBar: true,
    };

  // PENDING, which covers three quite different situations.
  if (!context.online)
    return {
      label: 'Waiting for connection',
      tone: 'waiting',
      // Reassurance, because this is the state a technician sees in a basement
      // with a full day of recordings behind them.
      detail: transferred ? `${transferred} sent so far` : 'Saved on this device.',
      localFileRetained: true,
      showProgressBar: (item.uploadedBytes ?? 0) > 0,
    };

  const retryAt = item.nextAttemptAt ? new Date(item.nextAttemptAt).getTime() : null;
  if (retryAt && retryAt > now)
    return {
      label: 'Retry scheduled',
      tone: 'waiting',
      detail: attempts > 0 ? `Attempt ${attempts + 1} in a moment` : 'Retrying shortly',
      localFileRetained: true,
      showProgressBar: (item.uploadedBytes ?? 0) > 0,
    };

  return {
    label: 'Queued',
    tone: 'idle',
    detail: transferred ?? formatBytes(item.fileSize),
    localFileRetained: true,
    showProgressBar: (item.uploadedBytes ?? 0) > 0,
  };
}

/**
 * Which of two views of the same upload to show.
 *
 * A list refetched from the server can arrive with a stale copy of an upload
 * this device is actively pushing — the server only learns the final state.
 * Preferring the further-along local record stops the bar visibly jumping
 * backwards mid-upload, which reads as data loss.
 */
export function preferFresher(local: UploadItem | undefined, incoming: UploadItem): UploadItem {
  if (!local) return incoming;
  if (local.status === 'UPLOADING' && incoming.status !== 'COMPLETED') return local;
  if ((local.uploadedBytes ?? 0) > (incoming.uploadedBytes ?? 0)) return local;
  if (local.progress > incoming.progress && incoming.status !== 'COMPLETED') return local;
  return incoming;
}
