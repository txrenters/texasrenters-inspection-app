import type { FrameMarker, LocalMedia, VideoRecordingType } from '../domain/models';

/** The server files at most this many marked moments from one recording. */
export const MAX_FRAME_MARKERS = 60;

/**
 * What a Cloudflare upload session is told about how the room was filmed.
 *
 * The multipart upload always sent the capture summary and the marked moments;
 * the direct-to-Cloudflare one sent neither, so every Stream recording reached
 * the console with no coverage summary, and an Android phone had to decode the
 * finished video itself to turn its marked moments into photos (2026-10-06).
 * The server now files those frames from Cloudflare.
 */
export interface StreamCapture {
  captureSessionId?: string;
  capturePolicyVersion?: string;
  coverageStatus?: string;
  sensorConfidence?: string;
  clockwiseRotationDegrees?: number;
  counterClockwiseRotationDegrees?: number;
  startHeadingDegrees?: number;
  endHeadingDegrees?: number;
  returnedToStart?: boolean;
  sensorSupported?: boolean;
  manualConfirmation?: boolean;
  evidenceComplete?: boolean;
  snapshotCount?: number;
  findingMarkerCount?: number;
  frameMarkers?: FrameMarker[];
}

/**
 * The capture to send for one recording, or nothing.
 *
 * The coverage summary is the primary walkthrough's alone, as on the multipart
 * path. The marked moments go with either kind of take: Android marks them in
 * an additional clip as well, and the phone used to file those too.
 *
 * Only `frameMarkers` is sent, never the bare `frameMarkersMs`: a take recorded
 * by an earlier release has only the latter, and already cut its own frames on
 * the phone, so sending them would file every one twice.
 */
export function streamCaptureOf(
  media: Pick<LocalMedia, 'captureSummary' | 'frameMarkers'>,
  recordingType: VideoRecordingType,
): StreamCapture | undefined {
  const summary = recordingType === 'PRIMARY_AREA' ? media.captureSummary : undefined;
  const markers = (media.frameMarkers ?? [])
    .filter((marker) => Number.isFinite(marker.atMs) && marker.atMs >= 0)
    .slice(0, MAX_FRAME_MARKERS)
    .map((marker) => ({ atMs: Math.round(marker.atMs), captureType: marker.captureType }));
  if (!summary && !markers.length) return undefined;
  return {
    ...(summary
      ? {
          captureSessionId: summary.sessionId,
          capturePolicyVersion: summary.policyVersion,
          coverageStatus: summary.coverageStatus,
          sensorConfidence: summary.sensorConfidence,
          clockwiseRotationDegrees: summary.clockwiseRotationDegrees,
          counterClockwiseRotationDegrees: summary.counterClockwiseRotationDegrees,
          startHeadingDegrees: heading(summary.startHeadingDegrees),
          endHeadingDegrees: heading(summary.endHeadingDegrees),
          returnedToStart: summary.returnedToStart,
          sensorSupported: summary.sensorSupported,
          manualConfirmation: summary.manualConfirmation,
          evidenceComplete: summary.evidenceComplete,
          snapshotCount: summary.snapshotCount,
          findingMarkerCount: summary.findingMarkerCount,
        }
      : {}),
    ...(markers.length ? { frameMarkers: markers } : {}),
  };
}

/** A compass heading the server takes, or none: it refuses anything outside 0-360. */
function heading(degrees: number | undefined) {
  return degrees !== undefined && Number.isFinite(degrees) && degrees >= 0 && degrees <= 360
    ? degrees
    : undefined;
}
