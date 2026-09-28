/**
 * A quarter's days as circles on a map, the way the office draws them.
 *
 * One circle per day, sized to hold that day's properties, numbered in the
 * order the day falls in the quarter. The office sketched this by hand: a
 * blanket of numbered circles covering the patch, low numbers around the
 * outside working inwards, which is how a quarter is actually driven.
 *
 * The numbering is not invented here. A day already has a date, and the date
 * already has an order — this only reads it. What makes the low numbers sit
 * around the perimeter is the planner, which seeds each day at the property
 * furthest from the middle and takes its nearest neighbours; drawing them in
 * date order is therefore drawing that sweep.
 */

/** A stop as the map needs it: where it is, and which day it belongs to. */
export interface GroupableStop {
  id: string;
  latitude: number;
  longitude: number;
  /** `YYYY-MM-DD`, or null for a visit with no day yet. */
  scheduledOn: string | null;
}

export interface PlanGroup {
  /** The day, `YYYY-MM-DD`. */
  date: string;
  /** Its place in the quarter, from 1. What the office reads off the map. */
  number: number;
  stops: GroupableStop[];
  /** The middle of its properties. */
  latitude: number;
  longitude: number;
  /**
   * Far enough to reach every property in the day, in metres.
   *
   * Sized to the day rather than fixed, and that is the whole point of the
   * drawing. This portfolio averages 0.6 neighbours within 500m and 1.0 within
   * a kilometre, so one radius for every circle would hold thirty properties
   * over Katy and one out past Pecan Grove — which is the problem the office
   * is looking at the map to solve, not a way to show it.
   */
  radiusMeters: number;
}

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

/**
 * The smallest circle worth drawing around a day.
 *
 * A day whose properties sit on one street would otherwise draw as a dot
 * nobody can see or click, and two tenancies at one address as nothing at all.
 */
const MIN_RADIUS_M = 350;

/** A little air, so a property never sits exactly on its circle's edge. */
const EDGE_PADDING_M = 120;

/**
 * Group a plan's stops into the circles the office reads.
 *
 * Visits with no day are left out rather than gathered into a circle of their
 * own: they are not a day, and drawing them as one would put a group on the
 * map that nobody is going to drive.
 */
export function planGroups(stops: readonly GroupableStop[]): PlanGroup[] {
  const byDate = new Map<string, GroupableStop[]>();
  for (const stop of stops) {
    if (!stop.scheduledOn) continue;
    if (!Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude)) continue;
    const day = byDate.get(stop.scheduledOn);
    if (day) day.push(stop);
    else byDate.set(stop.scheduledOn, [stop]);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, day], index) => {
      const latitude = day.reduce((sum, stop) => sum + stop.latitude, 0) / day.length;
      const longitude = day.reduce((sum, stop) => sum + stop.longitude, 0) / day.length;
      const centre = { latitude, longitude };
      const furthest = day.reduce((most, stop) => Math.max(most, metresBetween(centre, stop)), 0);
      return {
        date,
        number: index + 1,
        stops: day,
        latitude,
        longitude,
        radiusMeters: Math.max(MIN_RADIUS_M, Math.round(furthest + EDGE_PADDING_M)),
      };
    });
}

/**
 * A circle as GeoJSON, because Mapbox draws metres as pixels otherwise.
 *
 * Mapbox's own circle layer takes a pixel radius, which shrinks a real 5km
 * group to a dot as somebody zooms out — the opposite of what a map of
 * distances is for. A polygon is in real coordinates, so it stays the size of
 * the ground it covers at every zoom.
 */
export function circlePolygon(group: PlanGroup, points = 64): [number, number][] {
  const latRadius = (group.radiusMeters / EARTH_RADIUS_M) * (180 / Math.PI);
  // Longitude degrees are shorter the further from the equator, so the circle
  // would draw as an egg without this.
  const lonRadius = latRadius / Math.cos((group.latitude * Math.PI) / 180);
  return Array.from({ length: points + 1 }, (_, index) => {
    const angle = (index / points) * 2 * Math.PI;
    return [
      group.longitude + lonRadius * Math.cos(angle),
      group.latitude + latRadius * Math.sin(angle),
    ] as [number, number];
  });
}
