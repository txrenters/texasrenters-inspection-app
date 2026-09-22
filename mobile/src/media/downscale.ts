import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { TARGET_LONG_EDGE } from './picture-size';

/**
 * Brings a photograph down to the long edge the camera aims for.
 *
 * ── WHY THIS EXISTS WHEN `pictureSize` ALREADY DID THE JOB ───────────────────
 *
 * It did the job on Android only. `pickPictureSize` reads the sizes a camera
 * offers and takes the smallest at least 2048 — and on iOS those come back as
 * preset *names*, "photo" and "high", which carry no resolution. Nothing
 * parses, the prop is left unset, and every iPhone photograph is captured at
 * the sensor's full resolution. `picture-size.ts` says so in its own comment;
 * what it could not say is that this leaves the whole iOS fleet uncapped.
 *
 * Measured on production, 2026-09-22: camera photographs averaging 1.83 MB and
 * reaching 3840 pixels wide, and uploads of a single photograph taking 20, 37
 * and 82 seconds — the reason a technician's submit appeared to hang for ten.
 *
 * ── AND THE GALLERY BYPASSED IT ENTIRELY ─────────────────────────────────────
 *
 * An imported photograph never goes near `pictureSize`: it is whatever the
 * camera roll holds. Those averaged **6.38 MB**. `quality` does not help — it
 * applies to JPEG encoding, and a screenshot is a PNG, which is exactly what
 * the first two imports were.
 *
 * ── WHY IT COSTS A NATIVE BUILD, AND WHY THAT IS NOW WORTH IT ────────────────
 *
 * `expo-image-manipulator` is a native module, which `picture-size.ts`
 * deliberately avoided: "adding one costs a native build, and three mobile
 * changes are already waiting on the next one". Those three have since
 * shipped, and `pictureSize` alone cannot reach iOS. Resizing after the fact
 * is still the second-best answer on Android — the large frame is allocated,
 * written and re-read — so the capture size stays, and this only runs when a
 * photograph arrives larger than the target anyway.
 */
export interface Downscaled {
  uri: string;
  width: number;
  height: number;
}

/**
 * The photograph at or below `TARGET_LONG_EDGE`, or exactly what it was given.
 *
 * Returns the original on any failure. A photograph that is larger than we
 * would like is still evidence; one that a resize threw away is gone, and a
 * technician standing in somebody's kitchen cannot take it again.
 */
export async function downscaleForUpload(
  photo: Downscaled,
  targetLongEdge: number = TARGET_LONG_EDGE,
): Promise<Downscaled> {
  const longEdge = Math.max(photo.width, photo.height);
  // Already small enough, or a size nobody reported. Re-encoding either would
  // cost time and detail for nothing.
  if (!longEdge || longEdge <= targetLongEdge) return photo;

  try {
    const scale = targetLongEdge / longEdge;
    const context = ImageManipulator.manipulate(photo.uri).resize({
      width: Math.round(photo.width * scale),
      height: Math.round(photo.height * scale),
    });
    const image = await context.renderAsync();
    /**
     * JPEG at the same quality the camera uses, so an imported photograph is
     * not visibly different from the ones beside it — and so a PNG screenshot
     * stops being a PNG, which is where most of those 6 MB were.
     */
    const saved = await image.saveAsync({ compress: 0.82, format: SaveFormat.JPEG });
    return { uri: saved.uri, width: saved.width, height: saved.height };
  } catch {
    return photo;
  }
}
