import {
  GUIDED_CAPTURE_POLICY,
  createRotationTracker,
  evaluateCapture,
  guidedCaptureState,
  normalizeHeading,
  returnedToStart,
  rotationProgress,
  shortestSignedDelta,
  updateRotationTracker,
  type RotationTracker,
  clampRotationDegrees,
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

  it('does not advance while the phone is held still', () => {
    // The reported fault: the ring filled itself with nobody turning. Every
    // accepted sample added its magnitude to the clockwise total, and noise has
    // a magnitude whichever way it happens to point, so the total only ever
    // grew. A minute of 5 Hz samples wobbling a couple of degrees was enough to
    // report a full lap.
    const still = [0];
    for (let index = 1; index <= 300; index += 1) {
      // Alternating either side of the starting heading: no net movement, but
      // every step is above the jitter floor and so is accepted.
      still.push(index % 2 === 0 ? 1.6 : 358.5);
    }
    const tracker = track(still, 200);

    expect(tracker.acceptedSamples).toBeGreaterThan(250);
    // The gross counter still climbs — that is what it measures.
    expect(tracker.clockwiseRotationDegrees).toBeGreaterThan(360);
    // What the technician sees does not.
    expect(tracker.peakNetClockwiseDegrees).toBeLessThan(10);
    expect(rotationProgress(tracker)).toBeLessThan(0.03);
    expect(
      evaluateCapture({ tracker, durationSeconds: 60, sensorSupported: true }).status,
    ).not.toBe('COMPLETE');
    expect(
      guidedCaptureState({
        tracker,
        recording: true,
        sensorSupported: true,
        durationSeconds: 60,
      }),
    ).toBe('ROTATE_CLOCKWISE');
  });

  it('keeps a completed lap after the technician turns back to the door', () => {
    // Progress is taken from the furthest point reached, so facing the way you
    // came does not un-walk the room.
    const lap = track([0, 330, 300, 270, 240, 210, 180, 150, 120, 90, 60, 30, 0]);
    expect(rotationProgress(lap)).toBe(1);

    const turnedBack = track([30, 60, 90], 500, lap);
    expect(turnedBack.netClockwiseDegrees).toBeLessThan(lap.netClockwiseDegrees);
    expect(rotationProgress(turnedBack)).toBe(1);
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

describe('clampRotationDegrees', () => {
  // The upload DTO declares @Max(720) on both rotation fields. The tracker
  // accumulates every accepted degree and never caps, so a thorough walkthrough
  // sent a value the API rejects — failing the upload *after* the whole video
  // had been transferred. Only reachable once the motion sensor actually works.
  const CONTRACT_MAX = 720;

  it('matches the ceiling the upload contract accepts', () => {
    expect(GUIDED_CAPTURE_POLICY.maximumReportableRotationDegrees).toBe(CONTRACT_MAX);
  });

  it('caps a walkthrough that circled the room more than twice', () => {
    expect(clampRotationDegrees(1080)).toBe(CONTRACT_MAX);
    expect(clampRotationDegrees(721)).toBe(CONTRACT_MAX);
  });

  it('leaves an ordinary single loop untouched', () => {
    expect(clampRotationDegrees(361.4)).toBe(361);
    expect(clampRotationDegrees(0)).toBe(0);
  });

  it('never reports a negative or unusable rotation', () => {
    // @Min(0) is also declared on the DTO, so a bad sample must not become a
    // second way to fail the upload.
    expect(clampRotationDegrees(-5)).toBe(0);
    expect(clampRotationDegrees(Number.NaN)).toBe(0);
    // Zero, not the ceiling: a non-finite reading means the sensor produced
    // nonsense, and reporting a full two turns would fabricate coverage the
    // technician may never have walked.
    expect(clampRotationDegrees(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
