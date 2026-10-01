import type { UploadItem } from '../domain/models';
import { useDemoStore } from '../stores/demo.store';

/**
 * Whether an upload is still on its way: waiting, sending, or paused.
 *
 * Not FAILED -- a failed recording waits for a person, and an area waiting on
 * it would wait for good -- and not COMPLETED, which Cloudflare already has.
 */
export function recordingStillUploading(item: Pick<UploadItem, 'status'>) {
  return item.status === 'PENDING' || item.status === 'UPLOADING' || item.status === 'PAUSED';
}

/**
 * Whether this phone is still sending an area's walkthrough.
 *
 * The walkthrough, not an additional clip: the walkthrough is the evidence a
 * move-in or move-out area is completed on. Read from the device's own upload
 * queue, so it is true from the moment the recording is saved until Cloudflare
 * has every byte.
 *
 * A module of its own for the reason `room-snapshot-flush` is: both
 * `repositories.ts` and `offline-writes` need it, and the store wiring cannot
 * live in either without an import cycle.
 */
export function roomRecordingStillUploading(roomId: string): boolean {
  const { uploads, selectedUserId } = useDemoStore.getState();
  return uploads.some(
    (item) =>
      item.id.startsWith('local-upload-') &&
      item.ownerUserId === selectedUserId &&
      item.roomId === roomId &&
      (item.recordingType ?? 'PRIMARY_AREA') === 'PRIMARY_AREA' &&
      recordingStillUploading(item),
  );
}
