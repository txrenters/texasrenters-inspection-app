import { snapshotMode, stopRequestOutcome } from '../src/capture/capture-intents';

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
