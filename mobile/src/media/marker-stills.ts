import * as VideoThumbnails from 'expo-video-thumbnails';

import type { PhotoCaptureType } from '../domain/models';

/**
 * Cuts the moments a technician marked out of the recording, on the device.
 *
 * Android cannot photograph during a video: expo-camera binds either the
 * image-capture or the video-capture use case, never both, so the shutter
 * records an offset instead and something has to turn those offsets into
 * pictures. That used to be the server, with ffmpeg over the R2 object — but a
 * Cloudflare Stream recording never reaches the backend, so the marked moments
 * were being lost entirely on Android.
 *
 * Doing it here reads the file that is already on the device, so nothing is
 * downloaded and both platforms end up with the same evidence: iOS captures a
 * native still at the moment, Android extracts the equivalent frame afterwards.
 *
 * Must run before the local recording is cleaned up — after that the frames are
 * genuinely unrecoverable.
 */

export interface MarkerStill {
  uri: string;
  width: number;
  height: number;
  videoTimestampMs: number;
  captureType: PhotoCaptureType;
}

export interface MarkerStillFailure {
  videoTimestampMs: number;
  reason: string;
}

export interface MarkerStillResult {
  stills: MarkerStill[];
  failures: MarkerStillFailure[];
}

/**
 * Extract one still per marker.
 *
 * Failures are collected rather than thrown: a frame that cannot be decoded is
 * one lost still, and abandoning the rest — or worse, failing the upload of a
 * finished walkthrough — would cost far more than it saves. The caller reports
 * what was missed.
 */
export async function extractMarkerStills(
  localUri: string,
  markers: { videoTimestampMs: number; captureType: PhotoCaptureType }[],
  extract: (
    uri: string,
    options: { time: number; quality: number },
  ) => Promise<{ uri: string; width: number; height: number }> = (uri, options) =>
    VideoThumbnails.getThumbnailAsync(uri, options),
): Promise<MarkerStillResult> {
  const stills: MarkerStill[] = [];
  const failures: MarkerStillFailure[] = [];

  // Sequential on purpose. Each extraction decodes video, and running a dozen
  // at once on a mid-range phone competes with the upload already in flight.
  for (const marker of markers) {
    try {
      const frame = await extract(localUri, {
        // expo-video-thumbnails takes milliseconds, the same unit the shutter
        // recorded, so no conversion can drift.
        time: marker.videoTimestampMs,
        quality: 0.82,
      });
      stills.push({
        uri: frame.uri,
        width: frame.width,
        height: frame.height,
        videoTimestampMs: marker.videoTimestampMs,
        captureType: marker.captureType,
      });
    } catch (error) {
      failures.push({
        videoTimestampMs: marker.videoTimestampMs,
        reason: error instanceof Error ? error.message : 'The frame could not be read.',
      });
    }
  }
  return { stills, failures };
}

/**
 * Pair each recorded offset with the capture type chosen at the time.
 *
 * The two are collected in separate arrays as the technician taps, so they are
 * only meaningful together and only in order. A mismatch means one of them was
 * dropped; falling back to a neutral type keeps the frame rather than
 * discarding evidence over a label.
 */
export function pairMarkers(
  offsetsMs: readonly number[],
  captureTypes: readonly PhotoCaptureType[],
): { videoTimestampMs: number; captureType: PhotoCaptureType }[] {
  return offsetsMs.map((videoTimestampMs, index) => ({
    videoTimestampMs,
    captureType: captureTypes[index] ?? 'FINDING_CONTEXT',
  }));
}
