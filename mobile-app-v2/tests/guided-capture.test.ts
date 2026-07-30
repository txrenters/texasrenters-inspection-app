import {
  createRotationTracker,
  evaluateCapture,
  GUIDED_CAPTURE_POLICY,
  normalizeHeading,
  radiansOrDegreesToDegrees,
  returnedToStart,
  rotationProgress,
  rotationSpeed,
  shortestSignedDelta,
  sustainedWrongDirection,
  updateRotationTracker,
  type RotationTracker,
} from '../src/capture/guided-capture';
import { deriveGuidance, shouldPulse } from '../src/capture/guidance-state';

/**
 * DeviceMotion alpha increases counter-clockwise, so a *decreasing* heading is
 * a clockwise turn. Every helper here walks headings downward for clockwise.
 */
/**
 * Default pace is 25°/s — a realistic walkthrough speed that reads as GOOD, so
 * tests about rotation state are not accidentally testing speed coaching.
 */
function turn(
  tracker: RotationTracker,
  {
    degrees,
    clockwise = true,
    stepMs = 200,
    stepDegrees = 5,
  }: { degrees: number; clockwise?: boolean; stepMs?: number; stepDegrees?: number },
): RotationTracker {
  let next = tracker;
  let heading = next.previousHeadingDegrees ?? 0;
  let at = next.lastSampleAtMs ?? 0;
  for (let moved = 0; moved < degrees; moved += stepDegrees) {
    heading += clockwise ? -stepDegrees : stepDegrees;
    at += stepMs;
    next = updateRotationTracker(next, heading, at);
  }
  return next;
}

function started(atMs = 0) {
  return updateRotationTracker(createRotationTracker(), 0, atMs);
}

describe('angle maths', () => {
  it('normalises negative and oversized headings', () => {
    expect(normalizeHeading(-10)).toBe(350);
    expect(normalizeHeading(370)).toBe(10);
  });

  it('takes the short way around the 0/360 seam', () => {
    // The whole point of unwrapping: 359 -> 1 is +2, not -358.
    expect(shortestSignedDelta(359, 1)).toBe(2);
    expect(shortestSignedDelta(1, 359)).toBe(-2);
  });

  it('converts radians while leaving degrees alone', () => {
    expect(radiansOrDegreesToDegrees(Math.PI)).toBeCloseTo(180);
    expect(radiansOrDegreesToDegrees(180)).toBe(180);
  });
});

describe('updateRotationTracker', () => {
  it('accumulates clockwise rotation', () => {
    const tracker = turn(started(), { degrees: 90 });
    expect(tracker.clockwiseRotationDegrees).toBeCloseTo(90, 0);
    expect(tracker.counterClockwiseRotationDegrees).toBe(0);
  });

  it('does not let counter-clockwise movement inflate clockwise progress', () => {
    const tracker = turn(started(), { degrees: 90, clockwise: false });
    expect(tracker.clockwiseRotationDegrees).toBe(0);
    expect(tracker.counterClockwiseRotationDegrees).toBeCloseTo(90, 0);
    expect(rotationProgress(tracker)).toBe(0);
  });

  it('crosses the 0/360 seam without losing progress', () => {
    // A full turn walked through the wrap point must still read as a full turn.
    const tracker = turn(started(), { degrees: 360 });
    expect(tracker.clockwiseRotationDegrees).toBeCloseTo(360, 0);
    expect(rotationProgress(tracker)).toBe(1);
  });

  it('rejects jitter below the threshold', () => {
    const tracker = updateRotationTracker(started(), -0.4, 50);
    expect(tracker.clockwiseRotationDegrees).toBe(0);
    expect(tracker.rejectedSamples).toBe(1);
  });

  it('rejects an implausible jump rather than counting it as rotation', () => {
    // A sensor reset or a pocketed phone must not award 90 degrees of credit.
    const tracker = updateRotationTracker(started(), -120, 50);
    expect(tracker.clockwiseRotationDegrees).toBe(0);
    expect(tracker.rejectedSamples).toBe(1);
  });

  it('tracks smoothed angular velocity', () => {
    const slow = turn(started(), { degrees: 60, stepDegrees: 2, stepMs: 100 });
    const fast = turn(started(), { degrees: 60, stepDegrees: 10, stepMs: 50 });
    expect(fast.angularVelocityDegreesPerSecond).toBeGreaterThan(
      slow.angularVelocityDegreesPerSecond,
    );
  });

  it('works without timestamps, for callers that do not supply them', () => {
    let tracker = updateRotationTracker(createRotationTracker(), 0);
    tracker = updateRotationTracker(tracker, -10);
    expect(tracker.clockwiseRotationDegrees).toBeCloseTo(10, 0);
  });
});

describe('wrong-direction detection', () => {
  it('forgives a small correction', () => {
    // Glancing back at a light switch must never trigger a warning.
    const tracker = turn(turn(started(), { degrees: 90 }), {
      degrees: 8,
      clockwise: false,
    });
    expect(sustainedWrongDirection(tracker, tracker.lastSampleAtMs)).toBe(false);
  });

  it('warns only once the reverse is both large and sustained', () => {
    const brief = turn(turn(started(), { degrees: 90 }), {
      degrees: 30,
      clockwise: false,
      stepMs: 10,
    });
    // Large enough, but over in 60ms — still a correction, not a wrong turn.
    expect(sustainedWrongDirection(brief, brief.lastSampleAtMs)).toBe(false);

    const sustained = turn(turn(started(), { degrees: 90 }), {
      degrees: 40,
      clockwise: false,
      stepMs: 200,
    });
    expect(sustainedWrongDirection(sustained, sustained.lastSampleAtMs)).toBe(true);
  });

  it('clears the reverse run as soon as clockwise movement resumes', () => {
    const recovered = turn(
      turn(turn(started(), { degrees: 90 }), { degrees: 40, clockwise: false, stepMs: 200 }),
      { degrees: 20 },
    );
    expect(recovered.reverseRunDegrees).toBe(0);
    expect(sustainedWrongDirection(recovered, recovered.lastSampleAtMs)).toBe(false);
  });

  it('does not reset accumulated clockwise progress after a correction', () => {
    const tracker = turn(turn(started(), { degrees: 180 }), { degrees: 20, clockwise: false });
    expect(tracker.clockwiseRotationDegrees).toBeCloseTo(180, 0);
  });
});

describe('rotationSpeed', () => {
  it('reports stationary, good and too fast', () => {
    expect(rotationSpeed(createRotationTracker())).toBe('STATIONARY');
    expect(
      rotationSpeed({ ...createRotationTracker(), angularVelocityDegreesPerSecond: 25 }),
    ).toBe('GOOD');
    expect(
      rotationSpeed({
        ...createRotationTracker(),
        angularVelocityDegreesPerSecond: GUIDED_CAPTURE_POLICY.tooFastDegreesPerSecond + 10,
      }),
    ).toBe('TOO_FAST');
  });
});

describe('returnedToStart', () => {
  it('is true within tolerance and false outside it', () => {
    const full = turn(started(), { degrees: 360 });
    expect(returnedToStart(full)).toBe(true);

    const short = turn(started(), { degrees: 300 });
    expect(returnedToStart(short)).toBe(false);
  });
});

describe('evaluateCapture', () => {
  const full = () => turn(started(), { degrees: 360 });

  it('reports COMPLETE for a clean full turn', () => {
    expect(evaluateCapture({ tracker: full(), durationSeconds: 40, sensorSupported: true })).toMatchObject(
      { status: 'COMPLETE', confidence: 'HIGH', returnedToStart: true },
    );
  });

  it('does not report complete when the recording was too short', () => {
    // Spinning on the spot in five seconds is not a walkthrough.
    const result = evaluateCapture({ tracker: full(), durationSeconds: 5, sensorSupported: true });
    expect(result.status).not.toBe('COMPLETE');
  });

  it('falls back cleanly when the sensor is unavailable', () => {
    const result = evaluateCapture({
      tracker: createRotationTracker(),
      durationSeconds: 40,
      sensorSupported: false,
    });
    expect(result).toMatchObject({ status: 'SENSOR_UNAVAILABLE', confidence: 'UNAVAILABLE' });
  });

  it('honours a manual confirmation without claiming sensor confidence', () => {
    const result = evaluateCapture({
      tracker: createRotationTracker(),
      durationSeconds: 40,
      sensorSupported: false,
      manualConfirmation: true,
    });
    expect(result).toMatchObject({ status: 'MANUALLY_CONFIRMED', confidence: 'UNAVAILABLE' });
  });
});

describe('deriveGuidance', () => {
  const base = {
    sensorSupported: true,
    recording: true,
    startConfirmed: true,
    durationSeconds: 30,
  };

  it('asks for Wall 1 before anything else', () => {
    const guidance = deriveGuidance({
      ...base,
      tracker: createRotationTracker(),
      startConfirmed: false,
      recording: false,
    });
    expect(guidance.step).toBe('WAITING_FOR_START');
  });

  it('falls back to a manual instruction when the sensor is unavailable', () => {
    const guidance = deriveGuidance({
      ...base,
      tracker: createRotationTracker(),
      sensorSupported: false,
    });
    expect(guidance.step).toBe('SENSOR_UNAVAILABLE');
    // The procedure is unchanged; only the measuring is gone.
    expect(guidance.instruction).toMatch(/clockwise/i);
    expect(guidance.progress).toBe(0);
  });

  it('nudges toward the finish before the rotation is done', () => {
    // 320°: past the 85% mark but short of the 330° minimum.
    const guidance = deriveGuidance({ ...base, tracker: turn(started(), { degrees: 320 }) });
    expect(guidance.step).toBe('ALMOST_COMPLETE');
  });

  it('asks for a return to start when the turn is done but the heading is not', () => {
    // 335°: past the minimum, but 25° short of the start — outside tolerance.
    const guidance = deriveGuidance({ ...base, tracker: turn(started(), { degrees: 335 }) });
    expect(guidance.step).toBe('RETURNING_TO_START');
  });

  it('reports completion only after a full turn AND a return to start', () => {
    const guidance = deriveGuidance({ ...base, tracker: turn(started(), { degrees: 360 }) });
    expect(guidance.step).toBe('GUIDANCE_COMPLETE');
    // Names the next action rather than declaring the area finished.
    expect(guidance.instruction).toMatch(/stop and review/i);
  });

  it('prioritises wrong direction over pace', () => {
    const tracker = turn(turn(started(), { degrees: 90 }), {
      degrees: 60,
      clockwise: false,
      stepMs: 200,
      stepDegrees: 10,
    });
    const guidance = deriveGuidance({ ...base, tracker, nowMs: tracker.lastSampleAtMs });
    expect(guidance.step).toBe('WRONG_DIRECTION');
    expect(guidance.tone).toBe('warning');
  });

  it('never reports progress above 1', () => {
    const guidance = deriveGuidance({ ...base, tracker: turn(started(), { degrees: 400 }) });
    expect(guidance.progress).toBeLessThanOrEqual(1);
  });
});

describe('shouldPulse', () => {
  it('pulses once on entering a notable step, not on every update', () => {
    expect(shouldPulse('ROTATING_CLOCKWISE', 'WRONG_DIRECTION')).toBe(true);
    expect(shouldPulse('WRONG_DIRECTION', 'WRONG_DIRECTION')).toBe(false);
  });

  it('stays quiet for ordinary progress', () => {
    expect(shouldPulse('START_CONFIRMED', 'ROTATING_CLOCKWISE')).toBe(false);
    expect(shouldPulse('ROTATING_CLOCKWISE', 'TOO_FAST')).toBe(false);
  });
});
