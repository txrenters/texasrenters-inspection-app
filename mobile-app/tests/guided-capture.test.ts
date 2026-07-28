import {
  createRotationTracker,
  evaluateCapture,
  normalizeHeading,
  returnedToStart,
  shortestSignedDelta,
  updateRotationTracker,
} from '../src/capture/guided-capture';

function rotateClockwise(headings: number[]) {
  return headings.reduce(updateRotationTracker, createRotationTracker());
}

describe('guided capture rotation policy', () => {
  it('normalizes headings and handles the zero-degree boundary', () => {
    expect(normalizeHeading(-10)).toBe(350);
    expect(shortestSignedDelta(5, 355)).toBe(-10);
    expect(shortestSignedDelta(355, 5)).toBe(10);
  });

  it('accumulates clockwise movement across wraparound and recognizes return', () => {
    const tracker = rotateClockwise([0, 315, 270, 225, 180, 135, 90, 45, 0]);
    expect(tracker.clockwiseRotationDegrees).toBe(360);
    expect(tracker.counterClockwiseRotationDegrees).toBe(0);
    expect(returnedToStart(tracker)).toBe(true);
    expect(
      evaluateCapture({ tracker, durationSeconds: 20, sensorSupported: true }),
    ).toEqual({ status: 'COMPLETE', confidence: 'HIGH', returnedToStart: true });
  });

  it('does not turn sensor availability into proof of visual coverage', () => {
    const tracker = rotateClockwise([0, 330, 300]);
    expect(
      evaluateCapture({ tracker, durationSeconds: 20, sensorSupported: false }),
    ).toEqual({
      status: 'SENSOR_UNAVAILABLE',
      confidence: 'UNAVAILABLE',
      returnedToStart: false,
    });
  });

  it('flags wrong-way and partial capture without blocking manual confirmation', () => {
    const tracker = rotateClockwise([0, 30, 60, 90]);
    expect(
      evaluateCapture({ tracker, durationSeconds: 8, sensorSupported: true }).status,
    ).toBe('INCOMPLETE');
    expect(
      evaluateCapture({
        tracker,
        durationSeconds: 8,
        sensorSupported: true,
        manualConfirmation: true,
      }).status,
    ).toBe('MANUALLY_CONFIRMED');
  });
});
