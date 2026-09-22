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
   * And because it is released early the handler is re-entrant: two taps in a
   * row overlap, so the photograph's number cannot be read from a render
   * closure or both would be filed under the same one.
   */
  it('numbers photographs from a ref rather than the rendered count', () => {
    expect(source).toContain('photoCountRef');
    expect(source).not.toContain('sequenceNumber: photoCount + 1');
  });
});
