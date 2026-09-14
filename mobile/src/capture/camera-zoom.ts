/**
 * Zoom on the capture screen: the ultra-wide lens for 0.5x, and a pinch to zoom in.
 *
 * Asked for from the field as "zoom in/out, .5 to 2.0". Two limits of the
 * installed expo-camera shape what can honestly be offered without a new
 * native build:
 *
 * - **0.5x is a different lens, and only iOS lets the app choose one.** Its
 *   `selectedLens` takes the camera's localized name; Android has no lens
 *   selection, and its zoom never goes below 1x.
 * - **The app cannot know the zoom factor.** `zoom` is 0..1 of a maximum the
 *   library does not report -- linear on Android, exponential on iOS -- so
 *   there is no honest way to label a point on the pinch "2x". The pinch is
 *   bounded to roughly two to three times instead, and shown as a level, not a
 *   number.
 */

/** The two back lenses the zoom chips switch between, by the names iOS gives them. */
export interface BackLenses {
  main?: string;
  ultraWide?: string;
}

/**
 * The physical wide and ultra-wide lenses, from iOS's list of lens names.
 *
 * The names are localized display names, not device types, so this matches
 * the English ones ("Back Camera", "Back Ultra Wide Camera"). On any other
 * language nothing matches and the chips are simply not offered -- choosing a
 * lens by a guessed name could just as easily pick the wrong one.
 *
 * The virtual "Dual Wide" and "Triple" cameras are skipped on purpose. Their
 * zoom starts at the ultra-wide view and switches lens part-way along a zoom
 * this app cannot measure, so "1x" on one of them would not be 1x.
 */
export function pickBackLenses(names: readonly string[]): BackLenses {
  return {
    main: names.find((name) => /^back camera$/i.test(name.trim())),
    ultraWide: names.find(
      (name) => /ultra\s*wide/i.test(name) && !/dual|triple/i.test(name),
    ),
  };
}

/**
 * How far a pinch may zoom, as the library's 0..1 `zoom`.
 *
 * iOS maps `zoom` exponentially onto the lens's maximum (sixteen on many
 * phones), Android linearly with a floor of 1x (a maximum of eight to ten), so
 * the same fraction lands on different factors. These bounds keep both at
 * roughly 2x to 3x at full pinch -- enough to read a label or a serial plate,
 * short of digital zoom so deep the photograph is mush.
 */
const IOS_MAX_ZOOM = 0.3;
const ANDROID_MIN_ZOOM = 0.1;
const ANDROID_MAX_ZOOM = 0.3;

/**
 * The `zoom` prop for a pinch level from 0 (none) to 1 (full).
 *
 * Android starts its range above zero because everything below one over the
 * maximum is clamped to 1x: a pinch that began at zero would do nothing for its
 * first third and feel broken.
 */
export function cameraZoomFor(level: number, platform: string): number {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
  if (clamped === 0) return 0;
  if (platform === 'android')
    return ANDROID_MIN_ZOOM + clamped * (ANDROID_MAX_ZOOM - ANDROID_MIN_ZOOM);
  return clamped * IOS_MAX_ZOOM;
}

/**
 * The pinch level after the fingers have spread or closed by `scale`.
 *
 * Relative to where the pinch started, so a second pinch carries on from the
 * first rather than jumping. Spreading to double the distance goes from none
 * to full.
 */
export function pinchLevel(startLevel: number, scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return startLevel;
  return Math.max(0, Math.min(1, startLevel + (scale - 1)));
}
