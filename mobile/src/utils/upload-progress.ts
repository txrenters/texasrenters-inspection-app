/**
 * Upload progress is a **0–1 fraction** everywhere it is produced.
 *
 * `createUploadTask` reports `sent / expected`, the API sends `0` or `1`, and
 * the demo store ticks in increments of 0.035. The Uploads screen rendered it
 * straight into `width: ${progress}%`, so a half-finished transfer drew a bar
 * 0.5% wide and printed "0.5063291139240506%". The bar was not broken — it was
 * being fed a fraction where a percentage was expected, which looks identical
 * to an upload that never starts.
 *
 * One converter, so the two cannot drift apart again.
 */
export function progressPercent(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  // Tolerate a value that is already a percentage rather than rendering 9900%:
  // nothing produces one today, but a future endpoint might, and an absurd bar
  // is worse than a slightly optimistic one.
  const normalized = fraction > 1 ? fraction / 100 : fraction;
  return Math.round(Math.max(0, Math.min(1, normalized)) * 100);
}

/**
 * Width for a progress bar, floored so an upload that has genuinely started is
 * visibly distinct from one sitting at zero.
 */
export function progressBarWidth(fraction: number): `${number}%` {
  const percent = progressPercent(fraction);
  // Returned as a `${number}%` template type, not `string`: React Native's
  // `width` accepts DimensionValue, and a plain string does not satisfy it.
  return `${percent > 0 && percent < 2 ? 2 : percent}%`;
}
