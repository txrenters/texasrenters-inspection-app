import { photoCaptureClaim, type PhotoCaptureClaim } from '@texasrenters/shared';

/**
 * The phone's time zone name, or undefined when it cannot say.
 *
 * Read when a photograph is taken, never at module load, and inside a try:
 * Hermes's `Intl` differs by platform and version, and no part of a photograph's
 * time is worth failing the shutter over. Without a name the offset still says
 * which clock the time was read from.
 */
export function deviceTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone.length > 0 ? zone : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The moment the shutter fired, by this phone's clock, in its zone.
 *
 * Taken before the camera is asked for the picture. The photograph used to be
 * timed when its file was saved afterwards, and the server stamped it with the
 * moment the upload arrived -- fifteen seconds later at best, hours later for a
 * phone that was offline.
 */
export function shutterClock(atMs: number = Date.now()): PhotoCaptureClaim {
  return photoCaptureClaim(atMs, deviceTimeZone());
}

/**
 * The moment a frame cut from this phone's recording shows.
 *
 * Android cannot take a still while recording, so the shutter marks an offset
 * into the video and the frame is cut once recording stops. That frame shows
 * the recording's start plus the offset -- not the moment it was cut, which is
 * after the whole walkthrough.
 */
export function frameClock(recordingStartedAtMs: number, videoTimestampMs: number): PhotoCaptureClaim {
  return shutterClock(recordingStartedAtMs + Math.max(0, videoTimestampMs));
}
