import { VIDEO_NEVER_ARRIVED } from '../technician/media-processing.service';

/**
 * A room's status as the reports word it, where its own video is still on its
 * way from the technician's phone or never reached the server (2026-11-14).
 *
 * The room was walked, so "Not inspected" -- what a room with no video here
 * used to print -- told an owner something untrue. Its own recording decides:
 * one that is here leaves the room's status as it is; otherwise one still
 * arriving, or one the wait gave up on, says so.
 */
export function reportRoomStatus(
  completionStatus: string,
  primaryVideos: readonly {
    uploadStatus: string;
    readyAt: Date | null;
    processingStatus: string;
    failureCode: string | null;
  }[] = [],
): string {
  if (completionStatus === 'COMPLETED' || completionStatus === 'SKIPPED') return completionStatus;
  const arrived = primaryVideos.some(
    (video) => video.uploadStatus === 'UPLOADED' || Boolean(video.readyAt),
  );
  if (arrived) return completionStatus;
  if (primaryVideos.some((video) => video.failureCode === VIDEO_NEVER_ARRIVED)) return 'VIDEO_NEVER_ARRIVED';
  if (primaryVideos.some((video) => video.processingStatus === 'PENDING')) return 'VIDEO_ARRIVING';
  return completionStatus;
}

/** What `reportRoomStatus` reads of a room's own recordings, for a report's area select. */
export const PRIMARY_VIDEO_STATE = {
  where: { recordingType: 'PRIMARY_AREA' as const },
  select: { uploadStatus: true, readyAt: true, processingStatus: true, failureCode: true },
};
