/**
 * How long one area's recording may run, and when the technician is told.
 *
 * Ten minutes a take -- far past the 29 seconds the office's previous app
 * allowed, which is what Moses asked about on a move-out
 * (2026-10-02). The camera stops itself at the limit and keeps what it filmed,
 * which used to happen without a word: a technician mid-sentence in a long
 * garage found themselves on the review screen. The last minute now counts
 * down, and is announced once.
 *
 * The server accepts up to thirty minutes (`MAX_DURATION_SECONDS`), so this is
 * the limit that applies; raising it is a change here alone.
 */
export const MAX_RECORDING_SECONDS = 10 * 60;

/** From how far out the time left is shown and said. */
export const RECORDING_LIMIT_WARNING_SECONDS = 60;

/** Seconds left before the camera stops itself, once inside the warning; null before that. */
export function recordingTimeLeft(elapsedSeconds: number): number | null {
  const left = MAX_RECORDING_SECONDS - elapsedSeconds;
  return left <= RECORDING_LIMIT_WARNING_SECONDS ? Math.max(0, left) : null;
}

/** Whether a take that just ended was stopped by the limit rather than by the technician. */
export function stoppedByLimit(elapsedSeconds: number, stoppedByTechnician: boolean): boolean {
  // A second's grace: the elapsed clock is a timer beside the recording, not
  // the recording itself, and the two drift by a tick.
  return !stoppedByTechnician && elapsedSeconds >= MAX_RECORDING_SECONDS - 1;
}

/**
 * The walkthrough's video bitrate: 2.5 Mbps, about 19.5 MB a minute with the
 * sound at 720p.
 *
 * 4 Mbps from 2026-10-06 (the office's cap; unset, phones used 8 to 12). Down
 * to 2.5 on 2026-11-14, when the office said slow video uploads were holding
 * up its work: a move-out's 15 to 25 minutes of video was 460 to 770 MB to
 * send over mobile data, and a job cannot be submitted until it has all
 * arrived. The AI reads 640-pixel frames and the transcript reads the sound,
 * which is unchanged, so neither needs more.
 */
export const RECORDING_VIDEO_BITRATE = 2_500_000;

/**
 * The most a take may weigh before the camera stops it and keeps it: 195 MiB.
 *
 * Under the 200 MiB that the phone's own background uploader sends in one
 * request (`WHOLE_FILE_MAX_BYTES`), with room for the file's index. Ten minutes
 * at `RECORDING_VIDEO_BITRATE` is about 190 MB with the sound, so the time limit
 * normally comes first; this catches a phone whose encoder runs over its
 * bitrate. A larger take would be sent in chunks, which only go while the app
 * is open, and stop when the phone locks.
 */
export const MAX_RECORDING_BYTES = 195 * 1024 * 1024;

/**
 * Whether a take was stopped by `MAX_RECORDING_BYTES` rather than by the
 * technician. Both platforms stop a little short of the size and keep the take.
 */
export function stoppedBySizeLimit(sizeBytes: number | undefined, stoppedByTechnician: boolean): boolean {
  return !stoppedByTechnician && sizeBytes !== undefined && sizeBytes >= MAX_RECORDING_BYTES - 2 * 1024 * 1024;
}
