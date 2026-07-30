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
  /**
   * Coaching thresholds. Deliberately generous: a technician glancing at a
   * light switch should never be told they are going the wrong way, so a
   * reverse only counts once it is both large enough and sustained.
   */
  tooFastDegreesPerSecond: 55,
  stationaryDegreesPerSecond: 3,
  sustainedReverseMs: 1_200,
  /** A reverse shorter than this is a natural correction and is forgiven. */
  reverseForgivenessDegrees: 12,
  almostCompleteProgress: 0.85,
} as const;

export type CaptureCoverageStatus =
  | 'COMPLETE'
  | 'LIKELY_COMPLETE'
  | 'INCOMPLETE'
  | 'SENSOR_UNAVAILABLE'
  | 'LOW_CONFIDENCE'
  | 'MANUALLY_CONFIRMED';

export type CaptureSensorConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNAVAILABLE';

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
  acceptedSamples: number;
  rejectedSamples: number;
  // Timing-derived fields, added for speed and direction coaching. All optional
  // or zero-initialised so a tracker built by earlier code stays valid.
  lastSampleAtMs?: number;
  /** Smoothed magnitude, for "slow down" without reacting to single samples. */
  angularVelocityDegreesPerSecond: number;
  /** Signed direction of the most recent accepted movement. */
  lastDirection: RotationDirection;
  /** Degrees accumulated in the current unbroken reverse run. */
  reverseRunDegrees: number;
  reverseRunStartedAtMs?: number;
}

export type RotationDirection = 'CLOCKWISE' | 'COUNTER_CLOCKWISE' | 'STATIONARY';

export function createRotationTracker(): RotationTracker {
  return {
    clockwiseRotationDegrees: 0,
    counterClockwiseRotationDegrees: 0,
    acceptedSamples: 0,
    rejectedSamples: 0,
    angularVelocityDegreesPerSecond: 0,
    lastDirection: 'STATIONARY',
    reverseRunDegrees: 0,
  };
}

export function normalizeHeading(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

export function shortestSignedDelta(previous: number, current: number) {
  return ((normalizeHeading(current) - normalizeHeading(previous) + 540) % 360) - 180;
}

/** Exponential smoothing weight for angular velocity. Higher = more responsive. */
const VELOCITY_SMOOTHING = 0.3;

export function updateRotationTracker(
  tracker: RotationTracker,
  headingDegrees: number,
  atMs?: number,
): RotationTracker {
  const heading = normalizeHeading(headingDegrees);
  if (tracker.previousHeadingDegrees === undefined) {
    return {
      ...tracker,
      startHeadingDegrees: heading,
      previousHeadingDegrees: heading,
      endHeadingDegrees: heading,
      lastSampleAtMs: atMs,
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
      lastSampleAtMs: atMs ?? tracker.lastSampleAtMs,
      rejectedSamples: tracker.rejectedSamples + 1,
    };
  }

  // DeviceMotion rotation alpha increases counter-clockwise on the platforms
  // supported by Expo, so a negative signed delta is clockwise.
  const clockwise = delta < 0;
  const elapsedMs =
    atMs !== undefined && tracker.lastSampleAtMs !== undefined
      ? Math.max(1, atMs - tracker.lastSampleAtMs)
      : undefined;
  const instantaneous = elapsedMs ? (magnitude / elapsedMs) * 1000 : undefined;
  const velocity =
    instantaneous === undefined
      ? tracker.angularVelocityDegreesPerSecond
      : tracker.angularVelocityDegreesPerSecond * (1 - VELOCITY_SMOOTHING) +
        instantaneous * VELOCITY_SMOOTHING;

  // A reverse run resets the moment the technician turns the right way again,
  // so a glance back never accumulates toward a warning across the whole take.
  const reverseRunDegrees = clockwise ? 0 : tracker.reverseRunDegrees + magnitude;
  // Stamped from the *previous* sample: the reverse began when the technician
  // started moving, not when the sample that noticed it arrived. Using `atMs`
  // here silently discards one sample interval from every measured run.
  const reverseRunStartedAtMs = clockwise
    ? undefined
    : (tracker.reverseRunStartedAtMs ?? tracker.lastSampleAtMs ?? atMs);

  return {
    ...tracker,
    previousHeadingDegrees: heading,
    endHeadingDegrees: heading,
    lastSampleAtMs: atMs ?? tracker.lastSampleAtMs,
    clockwiseRotationDegrees: tracker.clockwiseRotationDegrees + (clockwise ? magnitude : 0),
    counterClockwiseRotationDegrees:
      tracker.counterClockwiseRotationDegrees + (clockwise ? 0 : magnitude),
    angularVelocityDegreesPerSecond: velocity,
    lastDirection: clockwise ? 'CLOCKWISE' : 'COUNTER_CLOCKWISE',
    reverseRunDegrees,
    reverseRunStartedAtMs,
    acceptedSamples: tracker.acceptedSamples + 1,
  };
}

/**
 * Whether the technician has been turning the wrong way long enough to be told.
 *
 * Requires both a meaningful reverse *and* sustained duration. Either alone
 * produces false warnings — a quick look back at a light switch clears the
 * degree threshold in a fraction of a second.
 */
export function sustainedWrongDirection(tracker: RotationTracker, nowMs?: number): boolean {
  if (tracker.reverseRunDegrees < GUIDED_CAPTURE_POLICY.reverseForgivenessDegrees) return false;
  if (tracker.reverseRunStartedAtMs === undefined || nowMs === undefined)
    return tracker.reverseRunDegrees >= GUIDED_CAPTURE_POLICY.wrongDirectionWarningDegrees;
  return nowMs - tracker.reverseRunStartedAtMs >= GUIDED_CAPTURE_POLICY.sustainedReverseMs;
}

export type RotationSpeedState = 'GOOD' | 'TOO_FAST' | 'STATIONARY';

export function rotationSpeed(tracker: RotationTracker): RotationSpeedState {
  const speed = tracker.angularVelocityDegreesPerSecond;
  if (speed > GUIDED_CAPTURE_POLICY.tooFastDegreesPerSecond) return 'TOO_FAST';
  if (speed < GUIDED_CAPTURE_POLICY.stationaryDegreesPerSecond) return 'STATIONARY';
  return 'GOOD';
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

export function radiansOrDegreesToDegrees(value: number) {
  return Math.abs(value) <= Math.PI * 2 + 0.25 ? (value * 180) / Math.PI : value;
}
