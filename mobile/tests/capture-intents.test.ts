import { initialCameraMode, snapshotMode, stopRequestOutcome } from '../src/capture/capture-intents';

/**
 * Exercised as predicates rather than through a renderer, matching the
 * convention in the other rule tests — there is no react renderer in this
 * project, and the rule is what matters, not React's plumbing.
 */
describe('what a shutter tap can capture', () => {
  it('can only mark the moment on Android mid-recording', () => {
    // expo-camera binds either image capture or video capture on Android,
    // never both, so there is nothing to shoot with while a take is running.
    expect(snapshotMode('android', true)).toBe('marker');
  });

  it('takes a real still everywhere else', () => {
    // iOS has no such limit and photographs during a take.
    expect(snapshotMode('ios', true)).toBe('still');
    // An idle Android camera has image capture bound, so the shutter works.
    expect(snapshotMode('android', false)).toBe('still');
    expect(snapshotMode('ios', false)).toBe('still');
  });
});

describe('what a stop control does', () => {
  it('asks before ending a running take', () => {
    expect(stopRequestOutcome({ recording: true, stopping: false })).toBe('confirm');
  });

  it('ignores a second tap once stopping is under way', () => {
    // Both stop controls stay on screen while the take saves, and stacking a
    // second sheet on the first is the documented way to make a React Native
    // Modal never appear again.
    expect(stopRequestOutcome({ recording: true, stopping: true })).toBe('ignore');
  });

  it('ignores a tap when nothing is recording', () => {
    // The header arrow is a plain back control the rest of the time, and must
    // not raise a question about ending a take that never started.
    expect(stopRequestOutcome({ recording: false, stopping: false })).toBe('ignore');
    expect(stopRequestOutcome({ recording: false, stopping: true })).toBe('ignore');
  });
});

/**
 * Reported from the field, 2026-09-10: "I can't take a picture without making a
 * recording first — for occupied inspection we want it fast."
 *
 * It was never a rule. `mode` on `CameraView` selects image **or** video output
 * and the screen hard-coded `video`, so the image-capture use case was never
 * bound and `takePictureAsync` had nothing to shoot with on Android. A default
 * nobody had revisited, wearing the costume of a workflow requirement.
 */
describe('which use case the camera binds when the screen opens', () => {
  it('opens ready to photograph when the visit does not owe a recording', () => {
    // An occupied visit is often only photographs: look at the room, take a
    // picture, leave a note, film only if something warrants it.
    expect(initialCameraMode(false)).toBe('picture');
  });

  it('opens ready to film when the visit does owe a recording', () => {
    // A move-in or move-out is the condition record a comparison is built from,
    // and the walkthrough is the evidence — so filming is the first thing its
    // technician does, and making them wait for a rebind would be a regression.
    expect(initialCameraMode(true)).toBe('video');
  });

  it('is the only thing that decides the opening mode', () => {
    // Keyed on `inspectionRequiresAreaRecording`, the same rule the completion
    // gate and the server both read. Stated as a boolean so this file stays
    // free of the inspection-type taxonomy.
    expect(new Set([initialCameraMode(true), initialCameraMode(false)]).size).toBe(2);
  });
});
