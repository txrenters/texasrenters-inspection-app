import type { LocalMedia, UploadItem } from '../domain/models';
import { useDemoStore } from '../stores/demo.store';
import { releaseUploadedRecording } from './local-recordings';

/**
 * A recording the queue no longer holds, and has not for a day, is the
 * server's: its upload finished and was handed over. Only the file was left.
 *
 * The phones in the field carry a backlog of these: until 2026-10-06 nothing
 * deleted a recording once it was sent, so every walkthrough a technician ever
 * filmed was still on their phone. A day's grace covers the moment between a
 * recording being saved and being queued, and anything a person is still
 * looking at.
 */
export const RELEASE_AFTER_MS = 24 * 60 * 60_000;

export function releasedRecordings(
  media: readonly Pick<LocalMedia, 'id' | 'recordedAt'>[],
  uploads: readonly Pick<UploadItem, 'mediaId'>[],
  now = Date.now(),
): string[] {
  const queued = new Set(uploads.map((upload) => upload.mediaId));
  return media
    .filter((item) => !queued.has(item.id) && now - Date.parse(item.recordedAt) > RELEASE_AFTER_MS)
    .map((item) => item.id);
}

/** Deletes those recordings' files and forgets them. Once per launch is plenty. */
export function sweepReleasedRecordings(now = Date.now()) {
  const { media, uploads, removeMedia } = useDemoStore.getState();
  for (const id of releasedRecordings(media, uploads, now)) {
    const recording = media.find((item) => item.id === id);
    if (recording) releaseUploadedRecording(recording.uri);
    removeMedia(id);
  }
}
