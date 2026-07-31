export const GUIDED_CAPTURE_POLICY = {
  version: 'guided-area-v1',
  targetClockwiseDegrees: 360,
  minimumClockwiseDegrees: 330,
  maximumClockwiseDegrees: 420,
  returnToStartToleranceDegrees: 20,
  minimumDurationSeconds: 15,
  wrongDirectionWarningDegrees: 25,
  jitterDegrees: 1,
  maximumSampleDeltaDegrees: 45,
  maximumRecommendedDegreesPerSecond: 75,
  /**
   * Largest rotation the upload API accepts, mirroring `@Max(720)` on
   * TechnicianMediaUploadDto. The tracker itself accumulates without bound.
   */
  maximumReportableRotationDegrees: 720,
  tooFastWarningDurationMs: 500,
} as const;

export type CaptureCoverageStatus =
  | 'COMPLETE'
  | 'LIKELY_COMPLETE'
  | 'INCOMPLETE'
  | 'SENSOR_UNAVAILABLE'
  | 'LOW_CONFIDENCE'
  | 'MANUALLY_CONFIRMED';

export type CaptureSensorConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNAVAILABLE';

export type GuidedCaptureState =
  | 'READY'
  | 'RECORDING'
  | 'ROTATE_CLOCKWISE'
  | 'WRONG_DIRECTION'
  | 'TOO_FAST'
  | 'CONTINUE_AROUND_ROOM'
  | 'RETURN_TO_START'
  | 'LIKELY_COMPLETE'
  | 'COMPLETE'
  | 'SENSOR_UNAVAILABLE';

export type SnapshotCaptureSource =
  'NATIVE_STILL_DURING_VIDEO' | 'VIDEO_FRAME_EXTRACTION' | 'SEPARATE_PHOTO_CAPTURE';

export interface FindingMarker {
  id: string;
  videoTimestampMs: number;
  rotationDegrees: number;
  createdAt: string;
}

export interface GuidedCaptureSummary {
  sessionId: string;
  policyVersion: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  clockwiseRotationDegrees: number;
  counterClockwiseRotationDegrees: number;
  startHeadingDegrees?: number;
  endHeadingDegrees?: number;
  returnedToStart: boolean;
  sensorSupported: boolean;
  sensorConfidence: CaptureSensorConfidence;
  coverageStatus: CaptureCoverageStatus;
  manualConfirmation: boolean;
  evidenceComplete: boolean;
  snapshotCount: number;
  findingMarkerCount: number;
}

export interface RotationTracker {
  startHeadingDegrees?: number;
  previousHeadingDegrees?: number;
  endHeadingDegrees?: number;
  clockwiseRotationDegrees: number;
  counterClockwiseRotationDegrees: number;
  recentCounterClockwiseDegrees: number;
  smoothedDegreesPerSecond: number;
  fastRotationDurationMs: number;
  previousSampleAtMs?: number;
  acceptedSamples: number;
  rejectedSamples: number;
}

export function createRotationTracker(): RotationTracker {
  return {
    clockwiseRotationDegrees: 0,
    counterClockwiseRotationDegrees: 0,
    recentCounterClockwiseDegrees: 0,
    smoothedDegreesPerSecond: 0,
    fastRotationDurationMs: 0,
    acceptedSamples: 0,
    rejectedSamples: 0,
  };
}

export function normalizeHeading(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

export function shortestSignedDelta(previous: number, current: number) {
  return ((normalizeHeading(current) - normalizeHeading(previous) + 540) % 360) - 180;
}

export function updateRotationTracker(
  tracker: RotationTracker,
  headingDegrees: number,
  sampleAtMs = Date.now(),
): RotationTracker {
  const heading = normalizeHeading(headingDegrees);
  if (tracker.previousHeadingDegrees === undefined) {
    return {
      ...tracker,
      startHeadingDegrees: heading,
      previousHeadingDegrees: heading,
      endHeadingDegrees: heading,
      previousSampleAtMs: sampleAtMs,
      acceptedSamples: 1,
    };
  }

  const delta = shortestSignedDelta(tracker.previousHeadingDegrees, heading);
  const magnitude = Math.abs(delta);
  if (
    magnitude < GUIDED_CAPTURE_POLICY.jitterDegrees ||
    magnitude > GUIDED_CAPTURE_POLICY.maximumSampleDeltaDegrees
  ) {
    return {
      ...tracker,
      endHeadingDegrees: heading,
      rejectedSamples: tracker.rejectedSamples + 1,
    };
  }

  const elapsedMs = Math.max(16, sampleAtMs - (tracker.previousSampleAtMs ?? sampleAtMs - 50));
  const instantaneousSpeed = magnitude / (elapsedMs / 1000);
  const smoothedSpeed =
    tracker.acceptedSamples <= 1
      ? instantaneousSpeed
      : tracker.smoothedDegreesPerSecond * 0.72 + instantaneousSpeed * 0.28;
  const clockwise = delta < 0;
  const recentCounterClockwiseDegrees = clockwise
    ? Math.max(0, tracker.recentCounterClockwiseDegrees * 0.82 - magnitude * 0.35)
    : tracker.recentCounterClockwiseDegrees * 0.9 + magnitude;
  const fastRotationDurationMs =
    smoothedSpeed >= GUIDED_CAPTURE_POLICY.maximumRecommendedDegreesPerSecond
      ? tracker.fastRotationDurationMs + elapsedMs
      : Math.max(0, tracker.fastRotationDurationMs - elapsedMs * 1.5);

  return {
    ...tracker,
    previousHeadingDegrees: heading,
    endHeadingDegrees: heading,
    previousSampleAtMs: sampleAtMs,
    // DeviceMotion rotation alpha increases counter-clockwise on the platforms
    // supported by Expo, so a negative signed delta is clockwise.
    clockwiseRotationDegrees: tracker.clockwiseRotationDegrees + (clockwise ? magnitude : 0),
    counterClockwiseRotationDegrees:
      tracker.counterClockwiseRotationDegrees + (clockwise ? 0 : magnitude),
    recentCounterClockwiseDegrees,
    smoothedDegreesPerSecond: smoothedSpeed,
    fastRotationDurationMs,
    acceptedSamples: tracker.acceptedSamples + 1,
  };
}

export function rotationProgress(tracker: RotationTracker) {
  return Math.min(
    1,
    tracker.clockwiseRotationDegrees / GUIDED_CAPTURE_POLICY.targetClockwiseDegrees,
  );
}

export function returnedToStart(tracker: RotationTracker) {
  if (tracker.startHeadingDegrees === undefined || tracker.endHeadingDegrees === undefined)
    return false;
  return (
    Math.abs(shortestSignedDelta(tracker.startHeadingDegrees, tracker.endHeadingDegrees)) <=
    GUIDED_CAPTURE_POLICY.returnToStartToleranceDegrees
  );
}

export function guidedCaptureState({
  tracker,
  recording,
  sensorSupported,
  durationSeconds,
}: {
  tracker: RotationTracker;
  recording: boolean;
  sensorSupported: boolean;
  durationSeconds: number;
}): GuidedCaptureState {
  if (!recording) return 'READY';
  if (!sensorSupported) return 'SENSOR_UNAVAILABLE';
  if (tracker.acceptedSamples < 2) return 'RECORDING';

  const progress = rotationProgress(tracker);
  const didReturn =
    tracker.clockwiseRotationDegrees >= GUIDED_CAPTURE_POLICY.minimumClockwiseDegrees &&
    returnedToStart(tracker);
  const evaluation = evaluateCapture({
    tracker,
    durationSeconds,
    sensorSupported,
  });

  if (evaluation.status === 'COMPLETE') return 'COMPLETE';
  if (evaluation.status === 'LIKELY_COMPLETE') return 'LIKELY_COMPLETE';
  if (progress >= 0.92 && didReturn) return 'LIKELY_COMPLETE';
  if (progress >= 0.92) return 'RETURN_TO_START';
  if (
    tracker.recentCounterClockwiseDegrees >=
    GUIDED_CAPTURE_POLICY.wrongDirectionWarningDegrees
  )
    return 'WRONG_DIRECTION';
  if (
    tracker.fastRotationDurationMs >= GUIDED_CAPTURE_POLICY.tooFastWarningDurationMs
  )
    return 'TOO_FAST';
  if (progress >= 0.08) return 'CONTINUE_AROUND_ROOM';
  return 'ROTATE_CLOCKWISE';
}

export function evaluateCapture({
  tracker,
  durationSeconds,
  sensorSupported,
  manualConfirmation = false,
}: {
  tracker: RotationTracker;
  durationSeconds: number;
  sensorSupported: boolean;
  manualConfirmation?: boolean;
}): {
  status: CaptureCoverageStatus;
  confidence: CaptureSensorConfidence;
  returnedToStart: boolean;
} {
  const didReturn = returnedToStart(tracker);
  if (manualConfirmation)
    return {
      status: 'MANUALLY_CONFIRMED',
      confidence: sensorSupported ? 'LOW' : 'UNAVAILABLE',
      returnedToStart: didReturn,
    };
  if (!sensorSupported)
    return { status: 'SENSOR_UNAVAILABLE', confidence: 'UNAVAILABLE', returnedToStart: false };

  const sufficientRotation =
    tracker.clockwiseRotationDegrees >= GUIDED_CAPTURE_POLICY.minimumClockwiseDegrees &&
    tracker.clockwiseRotationDegrees <= GUIDED_CAPTURE_POLICY.maximumClockwiseDegrees;
  const sufficientDuration = durationSeconds >= GUIDED_CAPTURE_POLICY.minimumDurationSeconds;
  const wrongDirection =
    tracker.counterClockwiseRotationDegrees >= GUIDED_CAPTURE_POLICY.wrongDirectionWarningDegrees;
  const noisy =
    tracker.rejectedSamples > 8 ||
    (tracker.acceptedSamples > 0 && tracker.rejectedSamples / tracker.acceptedSamples > 0.35);

  if (sufficientRotation && sufficientDuration && didReturn && !wrongDirection && !noisy)
    return { status: 'COMPLETE', confidence: 'HIGH', returnedToStart: true };
  if (sufficientRotation && sufficientDuration && didReturn)
    return { status: 'LIKELY_COMPLETE', confidence: 'MEDIUM', returnedToStart: true };
  if (noisy) return { status: 'LOW_CONFIDENCE', confidence: 'LOW', returnedToStart: didReturn };
  return { status: 'INCOMPLETE', confidence: 'LOW', returnedToStart: didReturn };
}

/**
 * Brings accumulated rotation inside the range the upload contract accepts.
 *
 * `updateRotationTracker` adds every accepted degree of turn and never caps,
 * so a thorough walkthrough can pass two full circles. Sending that raw failed
 * DTO validation and rejected the entire upload *after* the video had been
 * transferred — the worst possible moment. Coverage is judged against 330–420
 * degrees, so clamping loses nothing that any decision depends on.
 */
export function clampRotationDegrees(degrees: number) {
  if (!Number.isFinite(degrees) || degrees <= 0) return 0;
  return Math.min(
    GUIDED_CAPTURE_POLICY.maximumReportableRotationDegrees,
    Math.round(degrees),
  );
}

export function radiansOrDegreesToDegrees(value: number) {
  return Math.abs(value) <= Math.PI * 2 + 0.25 ? (value * 180) / Math.PI : value;
}
