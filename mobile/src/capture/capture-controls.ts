import { PRESS_SURFACE } from '../components/ui/press';

/**
 * How the camera's two capture controls are drawn.
 *
 * Kept out of the screen for the same reason as `capture-intents.ts`: this
 * project has no React renderer, so a colour decided inside the camera screen
 * cannot be asserted. See tests/camera-controls.test.ts.
 *
 * ── WHY THE SHUTTER IS NOT RED ───────────────────────────────────────────────
 *
 * #221 filled the big button red whichever capture it took. Demoed to the
 * product owner, a red shutter read as "record", or as a warning, on a button
 * that takes a photograph. A camera's shutter is a white ring; red is what a
 * camera shows while a recording is running.
 *
 * So neither control is red at rest. Red appears only on the stop control while
 * a take is running, and on the dot beside the clock -- the one thing red means
 * on every camera a technician has used.
 *
 * ── WHY PALETTE WHITE AND RED RATHER THAN THEME TOKENS ───────────────────────
 *
 * The exception `GuidedCaptureOverlay` already documents: these sit on live
 * video, not on a themed surface, and the camera's chrome is white on a dark
 * scrim in both themes. `bg-background` would draw a black shutter over a black
 * viewfinder in dark mode. And the theme's `destructive` is a dark brick in
 * light mode, 2.8:1 against black -- too faint to say a take is running --
 * where the palette's red-500 is 5.6:1.
 */

/** The only red on the capture controls: a take is running. */
export const RECORDING_RED = 'bg-red-500';

export interface CaptureControlLook {
  /** The pressable ring. */
  ring: string;
  /**
   * The filled shape inside the ring: the shutter disc, or the stop square
   * while a take runs. Null where the glyph sits in the ring on its own.
   */
  disc: string | null;
  /** The glyph's colour, or null when nothing is drawn on the disc. */
  glyph: string | null;
}

/**
 * One control's appearance.
 *
 * `large` is the control the visit leads with; see `primaryCapture`.
 * `stopControl` is true only for the record control while its take is running,
 * which is when it has become the way to stop.
 */
export function captureControlLook({
  large,
  stopControl,
}: {
  large: boolean;
  stopControl: boolean;
}): CaptureControlLook {
  const ring = large
    ? `h-[72px] w-[72px] items-center justify-center rounded-full border-4 border-white ${PRESS_SURFACE}`
    : `h-14 w-14 items-center justify-center rounded-full border-2 border-white/80 bg-white/10 ${PRESS_SURFACE}`;
  // The conventional stop control: a red square inside the same ring.
  if (stopControl)
    return {
      ring,
      disc: large ? `h-8 w-8 rounded-md ${RECORDING_RED}` : `h-5 w-5 rounded-sm ${RECORDING_RED}`,
      glyph: null,
    };
  // A white shutter disc, the glyph saying which capture it takes. The small
  // control stays an outline, so the two never read as a pair of equals.
  return large
    ? {
        ring,
        disc: 'h-14 w-14 items-center justify-center rounded-full bg-white',
        glyph: 'text-black',
      }
    : { ring, disc: null, glyph: 'text-white' };
}
