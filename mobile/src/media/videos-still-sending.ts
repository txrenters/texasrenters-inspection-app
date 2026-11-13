import { useDemoStore } from '../stores/demo.store';
import type { UploadItem } from '../domain/models';

/** A video upload not finished: waiting, going, or held. A failed one is not "still sending". */
export const STILL_SENDING = new Set<UploadItem['status']>(['PENDING', 'UPLOADING', 'PAUSED']);

/**
 * How many of a job's videos this phone is still sending (2026-11-14).
 *
 * A job may now be ended with its videos still on their way; they go only while
 * the app is open with signal, so the job's row keeps saying so after End job --
 * the server's own count of finished rooms does not move until they land.
 * Counted from this technician's own queue, as `localUploads` reads it.
 */
export function videosStillSendingCount(
  uploads: readonly Pick<UploadItem, 'id' | 'inspectionId' | 'status' | 'ownerUserId'>[],
  inspectionId: string,
  userId: string | null | undefined,
): number {
  return uploads.filter(
    (item) =>
      item.id.startsWith('local-upload-') &&
      item.ownerUserId === userId &&
      item.inspectionId === inspectionId &&
      STILL_SENDING.has(item.status),
  ).length;
}

/** The same count, kept current as the queue moves. */
export function useVideosStillSending(inspectionId: string): number {
  return useDemoStore((state) => videosStillSendingCount(state.uploads, inspectionId, state.selectedUserId));
}
