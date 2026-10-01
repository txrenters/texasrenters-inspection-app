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
