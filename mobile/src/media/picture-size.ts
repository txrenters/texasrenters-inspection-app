/**
 * How large a still the camera should actually capture.
 *
 * `takePictureAsync` has no resize option, and nothing in this app downscaled a
 * photograph — `quality: 0.82` compresses, it does not shrink. So every snapshot
 * was captured at the sensor's full resolution: on a current handset that is
 * twelve megapixels and three to five megabytes, and an occupied inspection
 * runs to twenty-five or thirty of them. Roughly a hundred megabytes per visit,
 * over whatever signal the property has.
 *
 * The upload runner's own comment described photographs as "small and there are
 * more of them", and used that to justify sending exactly one per pass. The
 * second half was true.
 *
 * ── WHY A CAPTURE SIZE RATHER THAN A RESIZE ──────────────────────────────────
 *
 * Resizing after the fact means `expo-image-manipulator`, which is a native
 * module: adding one costs a native build, and three mobile changes are already
 * waiting on the next one. `pictureSize` is an existing prop on `CameraView`,
 * so this ships over the air — and it is strictly better anyway, because the
 * large image is never allocated, written to disk, read back and re-encoded.
 */

/**
 * The long edge we aim for, in pixels.
 *
 * A property inspection photograph is evidence of a condition — a scuff, a
 * stain, a cracked tile — viewed in a report or on a review screen, not printed
 * at A3. 2048 holds far more detail than either surface can show while cutting
 * a twelve-megapixel frame to roughly a fifth of its size.
 *
 * Aimed at rather than enforced. Cameras offer a fixed menu of sizes, so this
 * picks from what the device has instead of demanding an exact match.
 */
export const TARGET_LONG_EDGE = 2048;

/** A size the camera offers, once it is understood. */
type ParsedSize = { label: string; longEdge: number; pixels: number };

/**
 * Reads the "1920x1080" form, ignoring anything else.
 *
 * iOS reports capture presets by name — "photo", "high", "medium" — which carry
 * no resolution at all, and Android occasionally reports a label this does not
 * recognise. Those are skipped rather than guessed at: a preset ordering
 * invented here would be a guess about hardware, and getting it wrong degrades
 * evidence silently. When nothing parses, `pickPictureSize` returns undefined
 * and the caller leaves the prop unset, which is exactly today's behaviour.
 */
function parseSize(label: string): ParsedSize | null {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(label.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  return { label, longEdge: Math.max(width, height), pixels: width * height };
}

/**
 * The smallest offered size that is still at least as large as the target.
 *
 * Smallest-above rather than nearest, because the two failure directions are
 * not equal. Overshooting costs upload time; undershooting costs detail in a
 * photograph that may be the only evidence of a charge against a tenant, and
 * that cannot be recovered later. When every option is below the target the
 * largest is taken — the device simply cannot do better, and picking anything
 * else would throw away detail for no reason.
 *
 * Returns undefined when nothing is parseable, so the caller can leave
 * `pictureSize` unset rather than pass a label the camera will reject.
 */
export function pickPictureSize(
  available: readonly string[],
  targetLongEdge: number = TARGET_LONG_EDGE,
): string | undefined {
  const sizes = available.map(parseSize).filter((size): size is ParsedSize => size !== null);
  if (!sizes.length) return undefined;

  const atLeastTarget = sizes.filter((size) => size.longEdge >= targetLongEdge);
  const candidates = atLeastTarget.length ? atLeastTarget : sizes;
  // Ascending when we have room above the target, descending when we do not.
  // `pixels` breaks the tie so a 4:3 and a 16:9 frame with the same long edge
  // resolve consistently rather than by whatever order the device listed them.
  const best = atLeastTarget.length
    ? candidates.reduce((low, size) => (size.pixels < low.pixels ? size : low))
    : candidates.reduce((high, size) => (size.pixels > high.pixels ? size : high));
  return best.label;
}
