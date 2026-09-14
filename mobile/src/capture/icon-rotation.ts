/**
 * Turning the camera's controls to face the technician, without turning the screen.
 *
 * The app is locked to portrait in its native configuration, so a phone held
 * sideways keeps a portrait screen and every icon lies on its side. Photographs
 * already come out landscape -- the camera reads the sensors itself -- but the
 * screen "doesn't adjust, it just stays the same", which is how it was reported
 * from the field.
 *
 * Unlocking rotation would need a new native build. Turning the icons in place,
 * the way the iPhone's own camera does, needs only the accelerometer the app
 * already ships with.
 */

/** Degrees clockwise to turn an icon so it reads upright. */
export type IconRotation = 0 | 90 | -90;

/**
 * Below this much gravity across the screen, the phone is lying flat and says
 * nothing about which way is up. Keep whatever was showing.
 */
const FLAT_BELOW_G = 0.45;

/**
 * How close to a pose the phone must be before the icons move to it.
 *
 * Thirty-five degrees either side, out of the forty-five that would split the
 * difference. The gap is the hysteresis: a phone held at an angle between
 * portrait and landscape stays on whichever it came from instead of flicking
 * between them as the hand wobbles.
 */
const SNAP_WITHIN_DEGREES = 35;

const POSES: readonly IconRotation[] = [0, 90, -90];

/**
 * The rotation for one accelerometer sample.
 *
 * `sample` is expo-sensors' Accelerometer reading, in g. The two platforms
 * report opposite signs for the same pose: iOS gives the pull of gravity (an
 * upright phone reads y = -1), Android the force holding the phone up against
 * it (y = +1). Android is flipped to the iOS convention before anything else.
 *
 * Upside down is deliberately not a pose -- nobody photographs a room with the
 * phone inverted, and a transient flip while pocketing it should not spin the
 * controls.
 */
export function iconRotationFor(
  sample: { x: number; y: number },
  platform: string,
  current: IconRotation,
): IconRotation {
  const sign = platform === 'android' ? -1 : 1;
  const gx = sample.x * sign;
  const gy = sample.y * sign;
  if (!Number.isFinite(gx) || !Number.isFinite(gy) || Math.hypot(gx, gy) < FLAT_BELOW_G)
    return current;

  // Clockwise from upright, in screen terms. Upright portrait is 0; the left
  // edge down (phone turned anticlockwise) needs the icons turned clockwise.
  const angle = (Math.atan2(-gx, -gy) * 180) / Math.PI;

  let best: IconRotation = current;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const pose of POSES) {
    const distance = Math.abs(((angle - pose + 540) % 360) - 180);
    if (distance < bestDistance) {
      best = pose;
      bestDistance = distance;
    }
  }
  return bestDistance <= SNAP_WITHIN_DEGREES ? best : current;
}
