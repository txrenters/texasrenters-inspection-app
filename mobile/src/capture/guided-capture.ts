export const GUIDED_CAPTURE_POLICY = {
  version: 'guided-area-v1',
  targetClockwiseDegrees: 360,
  minimumClockwiseDegrees: 330,
  maximumClockwiseDegrees: 420,
  returnToStartToleranceDegrees: 20,
  minimumDurationSeconds: 15,
  wrongDirectionWarningDegrees: 25,
  /**
   * Slowest turn treated as movement, in degrees per second.
   *
   * Per second rather than per sample, because the sampling interval differs by
   * platform: a one-degree per-sample floor meant 5°/s on Android at 200ms but
   * 13°/s on iOS at 75ms, so an unhurried sweep registered nothing at all on
   * iOS while working on Android. A technician taking a full minute over a room
   * turns at 6°/s, which must count.
   *
   * Low enough to admit that, high enough to ignore the slow yaw drift of an
   * IMU with no heading reference, which runs a couple of degrees per minute.
   * It is not what rejects hand noise — noise is fast, so it passes this gate
   * and is cancelled instead by the net accumulation in `updateRotationTracker`.
   */
  jitterDegreesPerSecond: 2,
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
  /**
   * Gross turn in each direction — every accepted degree, counted separately.
   *
   * Diagnostics only. Neither may drive progress: sensor noise on a phone held
   * perfectly still still has a magnitude, so both climb whether or not anyone
   * turned, and a still phone would fill the ring by itself.
   */
  clockwiseRotationDegrees: number;
  counterClockwiseRotationDegrees: number;
  /**
   * Signed turn, clockwise positive. Noise reverses sign sample to sample and
   * cancels here, while a real sweep accumulates.
   */
  netClockwiseDegrees: number;
  /**
   * How far clockwise the sweep ever reached.
   *
   * Progress is measured from this rather than the live net so that turning
   * back to face the door does not undo a lap that was genuinely walked. It is
   * still noise-immune: a still phone's net wanders around zero, so its peak
   * creeps up by tens of degrees over a long recording, nowhere near a lap.
   */
  peakNetClockwiseDegrees: number;
  /** Furthest the net ever ran the other way, for a sweep taken anticlockwise. */
  troughNetClockwiseDegrees: number;
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
    netClockwiseDegrees: 0,
    peakNetClockwiseDegrees: 0,
    troughNetClockwiseDegrees: 0,
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
  const elapsedMs = Math.max(16, sampleAtMs - (tracker.previousSampleAtMs ?? sampleAtMs - 50));
  const instantaneousSpeed = magnitude / (elapsedMs / 1000);
  if (
    instantaneousSpeed < GUIDED_CAPTURE_POLICY.jitterDegreesPerSecond ||
    magnitude > GUIDED_CAPTURE_POLICY.maximumSampleDeltaDegrees
  ) {
    return {
      ...tracker,
      endHeadingDegrees: heading,
      rejectedSamples: tracker.rejectedSamples + 1,
    };
  }

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

  // DeviceMotion rotation alpha increases counter-clockwise on the platforms
  // supported by Expo, so a negative signed delta is clockwise — which is why
  // the net negates the delta to make clockwise the positive direction.
  const netClockwiseDegrees = tracker.netClockwiseDegrees - delta;

  return {
    ...tracker,
    previousHeadingDegrees: heading,
    endHeadingDegrees: heading,
    previousSampleAtMs: sampleAtMs,
    clockwiseRotationDegrees: tracker.clockwiseRotationDegrees + (clockwise ? magnitude : 0),
    counterClockwiseRotationDegrees:
      tracker.counterClockwiseRotationDegrees + (clockwise ? 0 : magnitude),
    netClockwiseDegrees,
    peakNetClockwiseDegrees: Math.max(tracker.peakNetClockwiseDegrees, netClockwiseDegrees),
    troughNetClockwiseDegrees: Math.min(tracker.troughNetClockwiseDegrees, netClockwiseDegrees),
    recentCounterClockwiseDegrees,
    smoothedDegreesPerSecond: smoothedSpeed,
    fastRotationDurationMs,
    acceptedSamples: tracker.acceptedSamples + 1,
  };
}

/**
 * Furthest the sweep travelled, whichever way it went.
 *
 * Direction-agnostic on purpose. Which sign of the sensor means clockwise
 * depends on a platform convention that has now been wrong twice, and the
 * failure is silent and total: the ring simply never leaves zero while the
 * technician walks the whole room. A room swept anticlockwise is still a room
 * covered, so coverage does not depend on getting that convention right — only
 * the on-screen prompt does, where being wrong is merely confusing.
 */
export function sweptDegrees(tracker: RotationTracker) {
  return Math.max(tracker.peakNetClockwiseDegrees, -tracker.troughNetClockwiseDegrees, 0);
}

export function rotationProgress(tracker: RotationTracker) {
  return Math.min(1, sweptDegrees(tracker) / GUIDED_CAPTURE_POLICY.targetClockwiseDegrees);
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
    sweptDegrees(tracker) >= GUIDED_CAPTURE_POLICY.minimumClockwiseDegrees &&
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

  // Judged on the net sweep, never the gross turn: a phone lying still
  // accumulates gross degrees from noise alone, and this decides whether an
  // area counts as covered.
  const swept = sweptDegrees(tracker);
  const sufficientRotation =
    swept >= GUIDED_CAPTURE_POLICY.minimumClockwiseDegrees &&
    swept <= GUIDED_CAPTURE_POLICY.maximumClockwiseDegrees;
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

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/**
 * How fast the device is turning about the world vertical, in degrees per
 * second, positive clockwise seen from above.
 *
 * This exists because `rotation.alpha` cannot answer the question. Both
 * platforms derive it from Euler angles — `SensorManager.getOrientation` on
 * Android, `CMAttitude.yaw` on iOS — and Euler yaw is degenerate when the
 * device is pitched to ±90°, which is precisely how a phone is held to film
 * walls. At that attitude yaw and roll are the same rotation and the value
 * wanders regardless of whether anyone turned.
 *
 * The gyroscope has no such singularity. Projecting its angular velocity onto
 * the measured direction of gravity gives the component of the turn about the
 * vertical, whatever attitude the phone is held at, and drops the components
 * from tilting or panning up and down. Gravity is read from
 * `accelerationIncludingGravity`, which both platforms report pointing down.
 *
 * Returns null when gravity is unreadable — during a hard jolt the vector is
 * dominated by the technician's own movement, and a guess would be worse than
 * a gap.
 */
export function verticalTurnRate(angularVelocity: Vector3, gravity: Vector3): number | null {
  const magnitude = Math.hypot(gravity.x, gravity.y, gravity.z);
  // Roughly a quarter to double g: enough to trust it as a vertical reference.
  if (!Number.isFinite(magnitude) || magnitude < 2.5 || magnitude > 20) return null;
  const projection =
    (angularVelocity.x * gravity.x +
      angularVelocity.y * gravity.y +
      angularVelocity.z * gravity.z) /
    magnitude;
  return Number.isFinite(projection) ? projection : null;
}
