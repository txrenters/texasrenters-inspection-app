/**
 * Distance on the ground, for the planning maps.
 *
 * This drew a quarter's days as numbered circles. The Groups tab now draws
 * them as the Group maker draws a template (`plan-day-groups.ts`, the office,
 * 2026-10-01); what is left here is the one measure the groups are judged by.
 */

const EARTH_RADIUS_M = 6_371_000;

/** Metres between two points, on the sphere. */
export function metresBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}
