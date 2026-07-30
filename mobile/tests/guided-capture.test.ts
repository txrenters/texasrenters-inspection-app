import {
  createRotationTracker,
  evaluateCapture,
  guidedCaptureState,
  normalizeHeading,
  returnedToStart,
  rotationProgress,
  shortestSignedDelta,
  updateRotationTracker,
  type RotationTracker,
} from '../src/capture/guided-capture';

function track(
  headings: number[],
  intervalMs = 500,
  initial: RotationTracker = createRotationTracker(),
) {
  return headings.reduce(
    (tracker, heading, index) =>
      updateRotationTracker(tracker, heading, index * intervalMs),
    initial,
  );
}

describe('guided walkthrough motion policy', () => {
  it('normalizes headings and handles wraparound without reversing direction', () => {
    expect(normalizeHeading(-10)).toBe(350);
    expect(shortestSignedDelta(5, 355)).toBe(-10);
    expect(shortestSignedDelta(355, 5)).toBe(10);
  });

  it('tracks one clockwise lap and recognizes the return to Wall 1', () => {
    const tracker = track([0, 330, 300, 270, 240, 210, 180, 150, 120, 90, 60, 30, 0]);

    expect(tracker.clockwiseRotationDegrees).toBe(360);
    expect(tracker.counterClockwiseRotationDegrees).toBe(0);
    expect(rotationProgress(tracker)).toBe(1);
    expect(returnedToStart(tracker)).toBe(true);
    expect(
      evaluateCapture({ tracker, durationSeconds: 20, sensorSupported: true }),
    ).toEqual({ status: 'COMPLETE', confidence: 'HIGH', returnedToStart: true });
    expect(
      guidedCaptureState({
        tracker,
        recording: true,
        sensorSupported: true,
        durationSeconds: 20,
      }),
    ).toBe('COMPLETE');
  });

  it('does not treat proximity to the starting heading as a completed lap', () => {
    const tracker = track([0, 358, 355]);

    expect(returnedToStart(tracker)).toBe(true);
    expect(
      guidedCaptureState({
        tracker,
        recording: true,
        sensorSupported: true,
        durationSeconds: 20,
      }),
    ).not.toBe('COMPLETE');
  });

  it('tolerates a small reverse correction but warns on sustained wrong-way movement', () => {
    const mostlyClockwise = track([0, 340, 320, 325]);
    expect(
      guidedCaptureState({
        tracker: mostlyClockwise,
        recording: true,
        sensorSupported: true,
        durationSeconds: 4,
      }),
    ).toBe('CONTINUE_AROUND_ROOM');

    const wrongWay = track([0, 12, 24, 36]);
    expect(
      guidedCaptureState({
        tracker: wrongWay,
        recording: true,
        sensorSupported: true,
        durationSeconds: 4,
      }),
    ).toBe('WRONG_DIRECTION');
  });

  it('uses a sustained speed warning instead of reacting to one fast sample', () => {
    const tooFast = track([0, 330, 300, 270, 240, 210, 180], 100);
    expect(
      guidedCaptureState({
        tracker: tooFast,
        recording: true,
        sensorSupported: true,
        durationSeconds: 1,
      }),
    ).toBe('TOO_FAST');
  });

  it('rejects sensor jumps and keeps the walkthrough operational without motion access', () => {
    const tracker = track([0, 250], 100);
    expect(tracker.rejectedSamples).toBe(1);
    expect(tracker.clockwiseRotationDegrees).toBe(0);
    expect(
      guidedCaptureState({
        tracker,
        recording: true,
        sensorSupported: false,
        durationSeconds: 5,
      }),
    ).toBe('SENSOR_UNAVAILABLE');
    expect(
      evaluateCapture({ tracker, durationSeconds: 20, sensorSupported: false }),
    ).toEqual({
      status: 'SENSOR_UNAVAILABLE',
      confidence: 'UNAVAILABLE',
      returnedToStart: false,
    });
  });
});
