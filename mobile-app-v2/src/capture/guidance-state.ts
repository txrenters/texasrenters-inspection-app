import {
  GUIDED_CAPTURE_POLICY,
  returnedToStart,
  rotationProgress,
  rotationSpeed,
  sustainedWrongDirection,
  type RotationTracker,
} from './guided-capture';

/**
 * The one instruction a technician sees at any moment.
 *
 * Deliberately a single step rather than the whole ten-point procedure: the
 * full list belongs in the Guide overlay, not permanently over the preview.
 * Pure, so the wording — which someone follows while walking around a
 * stranger's home — is testable.
 */
export type GuidanceStep =
  | 'SENSOR_UNAVAILABLE'
  | 'WAITING_FOR_START'
  | 'START_CONFIRMED'
  | 'ROTATING_CLOCKWISE'
  | 'TOO_FAST'
  | 'WRONG_DIRECTION'
  | 'ALMOST_COMPLETE'
  | 'RETURNING_TO_START'
  | 'GUIDANCE_COMPLETE';

export type GuidanceTone = 'neutral' | 'active' | 'warning' | 'success';

/** The clockwise arrow's presentation. Never the sole carrier of meaning. */
export type ArrowState = 'IDLE' | 'ACTIVE' | 'WARNING' | 'RETURN' | 'COMPLETE';

export type Guidance = {
  step: GuidanceStep;
  /** Short bold line — the state. */
  headline: string;
  /** One sentence — what to do about it. */
  instruction: string;
  /** 0–1 clockwise progress. Zero when the sensor cannot be trusted. */
  progress: number;
  tone: GuidanceTone;
  arrow: ArrowState;
  speed: ReturnType<typeof rotationSpeed>;
  /** True when this transition deserves a single haptic tap. */
  notable: boolean;
};

export type GuidanceInput = {
  tracker: RotationTracker;
  sensorSupported: boolean;
  recording: boolean;
  /** Whether the technician has confirmed their Wall 1 / start reference. */
  startConfirmed: boolean;
  durationSeconds: number;
  nowMs?: number;
};

export function deriveGuidance(input: GuidanceInput): Guidance {
  const { tracker, sensorSupported, recording, startConfirmed, durationSeconds, nowMs } = input;
  const speed = rotationSpeed(tracker);

  if (!sensorSupported)
    return {
      step: 'SENSOR_UNAVAILABLE',
      headline: 'Motion guidance unavailable',
      // Still actionable without a sensor: the procedure does not change, only
      // the app's ability to measure it does.
      instruction: 'Complete one slow clockwise turn and return to Wall 1.',
      progress: 0,
      tone: 'neutral',
      arrow: 'IDLE',
      speed,
      notable: false,
    };

  if (!startConfirmed)
    return {
      step: 'WAITING_FOR_START',
      headline: 'Face Wall 1',
      instruction: 'Point the camera at your starting wall, then confirm.',
      progress: 0,
      tone: 'neutral',
      arrow: 'IDLE',
      speed,
      notable: false,
    };

  if (!recording)
    return {
      step: 'START_CONFIRMED',
      headline: 'Wall 1 confirmed',
      instruction: 'Hold a wide view, then start recording.',
      progress: 0,
      tone: 'neutral',
      arrow: 'IDLE',
      speed,
      notable: false,
    };

  const progress = rotationProgress(tracker);
  const didReturn = returnedToStart(tracker);
  const complete =
    tracker.clockwiseRotationDegrees >= GUIDED_CAPTURE_POLICY.minimumClockwiseDegrees &&
    durationSeconds >= GUIDED_CAPTURE_POLICY.minimumDurationSeconds;

  if (complete && didReturn)
    return {
      step: 'GUIDANCE_COMPLETE',
      headline: '360° captured',
      // Names the next action rather than declaring the area finished: rotation
      // guidance and area completion are different things.
      instruction: 'Hold briefly at the start point, then stop and review.',
      progress: 1,
      tone: 'success',
      arrow: 'COMPLETE',
      speed,
      notable: true,
    };

  if (complete)
    return {
      step: 'RETURNING_TO_START',
      headline: 'Return to Wall 1',
      instruction: 'Keep turning slowly until you face where you began.',
      progress: Math.max(progress, 0.95),
      tone: 'active',
      arrow: 'RETURN',
      speed,
      notable: true,
    };

  // Wrong direction outranks pace: turning back the way you came wastes the
  // take, whereas turning a little fast only softens the evidence.
  if (sustainedWrongDirection(tracker, nowMs))
    return {
      step: 'WRONG_DIRECTION',
      headline: 'Wrong direction',
      instruction: 'Turn clockwise — to your right — to continue.',
      progress,
      tone: 'warning',
      arrow: 'WARNING',
      speed,
      notable: true,
    };

  if (speed === 'TOO_FAST')
    return {
      step: 'TOO_FAST',
      headline: 'Slow down',
      instruction: 'Move slower so the walls stay sharp.',
      progress,
      tone: 'warning',
      arrow: 'ACTIVE',
      speed,
      notable: false,
    };

  if (progress >= GUIDED_CAPTURE_POLICY.almostCompleteProgress)
    return {
      step: 'ALMOST_COMPLETE',
      headline: 'Almost complete',
      instruction: 'Keep going — Wall 1 is close.',
      progress,
      tone: 'active',
      arrow: 'RETURN',
      speed,
      notable: true,
    };

  if (speed === 'STATIONARY')
    return {
      step: 'ROTATING_CLOCKWISE',
      headline: 'Continue clockwise',
      instruction: 'Move to your right when ready. Pause on anything of concern.',
      progress,
      tone: 'active',
      arrow: 'ACTIVE',
      speed,
      notable: false,
    };

  return {
    step: 'ROTATING_CLOCKWISE',
    headline: progress > 0.05 ? 'Good pace' : 'Begin clockwise',
    instruction:
      progress > 0.05
        ? 'Keep the full wall in frame, top to bottom.'
        : 'Move slowly to your right.',
    progress,
    tone: 'active',
    arrow: 'ACTIVE',
    speed,
    notable: false,
  };
}

/**
 * Steps worth a haptic tap when first entered.
 *
 * Only transitions the technician needs to feel while looking at the room
 * rather than the screen. Repeated buzzing for the same state is worse than
 * none — it trains people to ignore it.
 */
const HAPTIC_STEPS: ReadonlySet<GuidanceStep> = new Set<GuidanceStep>([
  'WRONG_DIRECTION',
  'ALMOST_COMPLETE',
  'RETURNING_TO_START',
  'GUIDANCE_COMPLETE',
]);

export function shouldPulse(previous: GuidanceStep | null, next: GuidanceStep): boolean {
  return next !== previous && HAPTIC_STEPS.has(next);
}
