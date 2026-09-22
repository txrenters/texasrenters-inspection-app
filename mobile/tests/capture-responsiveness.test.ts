import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The capture button, as the office needs it: alive, and instant.
 *
 * Asserted against the screen's source, which is the pattern
 * `camera-controls.test.ts` established — the component binds a native camera
 * and cannot be rendered here, but these two invariants are worth a guard
 * because both were broken in ways nothing else would catch.
 */

const CAMERA_SCREEN = 'app/(app)/camera/[inspectionId]/[areaId].tsx';
const source = readFileSync(join(__dirname, '..', CAMERA_SCREEN), 'utf8');

describe('the shutter cannot latch itself off', () => {
  /**
   * `ready` is the only thing holding the shutter open, and `markCameraReady`
   * is the only thing that sets it. `bindCamera` clears it and waits for the
   * native `onCameraReady`; its timeout used to resolve the waiting promise and
   * stop there, so a callback that never came disabled the capture button for
   * as long as the screen stayed mounted.
   *
   * Reported on 2026-09-23 as "it won't touch... it touch when I retry and
   * refresh the app", and reachable from all three rebinds — worst from the one
   * after a recording stops, which killed the shutter for the rest of a visit.
   */
  it('gives the camera back when a rebind times out', () => {
    expect(source).toContain('setTimeout(markCameraReady, CAMERA_REBIND_TIMEOUT_MS)');
  });

  it('still has exactly one place that clears readiness, and one that restores it', () => {
    expect(source.match(/setReady\(false\)/g)).toHaveLength(1);
    expect(source.match(/setReady\(true\)/g)).toHaveLength(1);
  });

  /**
   * The rebind fallback is not enough on its own: `bindCamera` only runs for a
   * mode *change* and returns early when the mode already matches, so a fresh
   * mount arms nothing and readiness rests entirely on a native callback. That
   * callback is dropped in the flow the office runs -- photograph a filter
   * register, go back, tap the next one straight away, and a new camera mounts
   * while the previous session is still releasing the device.
   */
  it('gives the camera back even when nothing rebound it', () => {
    expect(source).toMatch(/if \(ready\) return;\s*\n\s*const timer = setTimeout\(markCameraReady, CAMERA_REBIND_TIMEOUT_MS\);/);
  });
});

describe('nothing else may swallow the shutter tap', () => {
  /**
   * The pinch handlers are spread over the *root* view and answered in the
   * capture phase, so claiming a gesture takes the touch before the shutter is
   * offered it. The test used to be "are there two touches on the glass", which
   * is true of a hand steadying the phone -- and the tap vanished with no flash
   * and no haptic. Not cured by restarting, because it follows the grip.
   */
  it('claims nothing on touch-down', () => {
    expect(source).toMatch(/onStartShouldSetPanResponderCapture: \(\) => \{\s*\n\s*pinchGate\.current = null;\s*\n\s*return false;/);
  });

  it('claims a move only once the fingers have really changed distance', () => {
    expect(source).toContain('Math.abs(distance - pinchGate.current) > PINCH_SLOP');
  });
});

describe('the controls do not move under the thumb', () => {
  /**
   * "Done — rate the room" appears on the first photograph and sits *below* the
   * controls in a bottom-anchored stack, so taking one shifted the shutter up
   * by its own height and the band the thumb was resting on became the top of
   * that button. The second shot of a room either hit nothing or left the
   * camera. The space is held from the first render instead.
   */
  it('reserves the Done row before there is anything in it', () => {
    // The wrapper carries the spacing; the button inside carries none, so the
    // stack is the same height whether or not there is anything to press.
    expect(source).toContain('<View className="mt-4 min-h-12 w-full">');
    expect(source).not.toContain('className={`mt-4 min-h-12 w-full flex-row');
  });
});

describe('a still that never lands', () => {
  /**
   * Everything that releases the button is downstream of `takePictureAsync`,
   * including the `finally` -- so a capture that never settles kept the shutter
   * for the life of the screen. Same shape as the readiness latch, on the other
   * half of the `disabled` expression.
   */
  it('hands the shutter back rather than holding it forever', () => {
    expect(source).toContain('CAPTURE_WATCHDOG_MS');
    expect(source).toMatch(/const watchdog = setTimeout\(/);
    // Cleared on the happy path and again in the finally; both idempotent.
    expect(source.match(/clearTimeout\(watchdog\)/g)).toHaveLength(2);
  });
});

describe('the shutter does not wait on filing', () => {
  /**
   * The office: "there's a loader animation on the capture when I try to
   * capture one, this will slow us on taking evidence". The spinner was the
   * visible half; the costly half was that `capturingPhoto` was held through
   * the downscale and the write to disk, so the next photograph waited on the
   * last one's paperwork.
   */
  it('shows no loader in place of the camera icon', () => {
    // The element, not the word: the comment above the fix names it.
    expect(source).not.toMatch(/<ActivityIndicator/);
  });

  /**
   * Released the moment the camera has the picture — which must be BEFORE the
   * downscale, or the wait is back.
   */
  it('releases the button before the image is downscaled', () => {
    const released = source.indexOf('setCapturingPhoto(false)');
    const downscaled = source.indexOf('await downscaleForUpload(');
    expect(released).toBeGreaterThan(-1);
    expect(downscaled).toBeGreaterThan(-1);
    expect(released).toBeLessThan(downscaled);
  });

  /**
   * Freeing the button was only half of it. The flash, the haptic and the count
   * sat below the downscale and the write to disk, so a tap produced nothing at
   * all for a fifth to half a second and only then flashed -- and with the
   * button already live, a second shot fired into that silence and the first
   * flash landed during the second capture.
   */
  it('confirms the shot before the image is downscaled', () => {
    // `counted = true` sits with the flash, the haptic and the count, so its
    // position is the position of everything the technician perceives.
    const confirmed = source.indexOf('counted = true;');
    const downscaled = source.indexOf('await downscaleForUpload(');
    expect(confirmed).toBeGreaterThan(-1);
    expect(confirmed).toBeLessThan(downscaled);
  });

  /**
   * And takes the count back down if the filing then fails, because
   * `photoCount` feeds `evidenceComplete` in the capture summary.
   */
  it('rolls the count back when the photograph could not be filed', () => {
    expect(source).toContain('if (counted) {');
  });

  /**
   * And because it is released early the handler is re-entrant: two taps in a
   * row overlap, so the photograph's number cannot be read from a render
   * closure or both would be filed under the same one.
   */
  it('numbers photographs from a ref rather than the rendered count', () => {
    expect(source).toContain('photoCountRef');
    expect(source).not.toContain('sequenceNumber: photoCount + 1');
  });
});
