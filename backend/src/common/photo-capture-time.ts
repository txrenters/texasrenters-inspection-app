import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { PhotoCaptureTimeSource } from '@prisma/client';
import { MAX_CAPTURE_CLOCK_AHEAD_MS } from '@texasrenters/shared';

/**
 * The capture time to store for a photograph a phone uploaded.
 *
 * The phone's claim is kept whatever happens, in `deviceCapturedAt`. It becomes
 * `capturedAt` only when it could be true: not after the upload arrived (beyond
 * a little clock drift), and not before the inspection existed to photograph.
 * Otherwise the receipt is stored and labelled as such -- a stamp on evidence
 * has to say when it is only a receipt.
 */
export function captureTimeForUpload(input: {
  claimed?: string | null;
  receivedAt: Date;
  earliest: Date;
  fromRecording?: boolean;
}) {
  const claimed = input.claimed ? new Date(input.claimed) : null;
  const valid = claimed && !Number.isNaN(claimed.getTime()) ? claimed : null;
  const plausible =
    valid !== null &&
    valid.getTime() <= input.receivedAt.getTime() + MAX_CAPTURE_CLOCK_AHEAD_MS &&
    valid.getTime() >= input.earliest.getTime() - MAX_CAPTURE_CLOCK_AHEAD_MS;
  return {
    deviceCapturedAt: valid,
    capturedAt: plausible ? valid : input.receivedAt,
    captureTimeSource: plausible
      ? input.fromRecording
        ? PhotoCaptureTimeSource.VIDEO_OFFSET
        : PhotoCaptureTimeSource.DEVICE_CLOCK
      : PhotoCaptureTimeSource.SERVER_RECEIPT,
  };
}

/**
 * The moment a frame cut from a recording shows.
 *
 * A recording's `recordedAt` is stamped by the phone when the take is saved,
 * which is when it stopped; the frame is its start plus the marked offset. The
 * duration is whole seconds, so this is good to about a second -- close enough
 * to be the frame's time, and labelled as coming from the recording.
 */
export function captureTimeForFrame(
  recording: { recordedAt: Date | null; durationSeconds: number },
  atMs: number,
  receivedAt: Date = new Date(),
) {
  if (!recording.recordedAt)
    return { capturedAt: receivedAt, captureTimeSource: PhotoCaptureTimeSource.SERVER_RECEIPT };
  const start = recording.recordedAt.getTime() - Math.max(0, recording.durationSeconds) * 1000;
  const at = Math.min(recording.recordedAt.getTime(), Math.max(start, start + atMs));
  return { capturedAt: new Date(at), captureTimeSource: PhotoCaptureTimeSource.VIDEO_OFFSET };
}

/** SHA-256 of a file on disk, streamed so a large photograph is never held twice. */
export function sha256OfFile(path: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}
