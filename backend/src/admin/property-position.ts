import type { Prisma } from '@prisma/client';

/**
 * Where a property is, by the one rule the whole console shares.
 *
 * **The geofence centre wins over the geocoder's pin.** They are usually the
 * same point, and where they are not it is because somebody stood at the
 * property and corrected it -- which is a better answer than an address lookup.
 *
 * This rule used to live only in the technician map's property positions.
 * Everything in planning -- the planner that groups a quarter, the plan's own
 * pins, the drawn route -- read the building's raw coordinates instead. So
 * wherever the office had corrected a position, the two maps disagreed about
 * where the property was, and the planner grouped it by a position the office
 * had already overruled. The office put it as wanting one map with "same
 * geocoding, same Venn diagram", and that is only true if every reader asks
 * this function.
 */

/** What to select from a building to know where it is. */
export const BUILDING_POSITION_SELECT = {
  latitude: true,
  longitude: true,
  geofence: { select: { latitude: true, longitude: true } },
} satisfies Prisma.PropertywareBuildingSelect;

/** A Prisma `Decimal`, a number, or nothing -- whatever a column hands back. */
type Coordinate = { toNumber(): number } | number | null | undefined;

const asNumber = (value: Coordinate): number | null => {
  if (value === null || value === undefined) return null;
  const number = typeof value === 'number' ? value : value.toNumber();
  return Number.isFinite(number) ? number : null;
};

export interface PositionedBuilding {
  latitude: Coordinate;
  longitude: Coordinate;
  /**
   * The office's correction, when there is one. A geofence can exist with
   * only its radii changed and its centre left alone, so both halves have to be
   * present for the centre to count as moved.
   */
  geofence?: { latitude: Coordinate; longitude: Coordinate } | null;
}

/**
 * The position every map and the planner use for a building, or null when it
 * has none at all.
 *
 * Numbers rather than `Decimal`s: a Decimal serialises to a *string* through
 * JSON, and a map given "-95.4012" plots nothing.
 */
export function propertyPosition(
  building: PositionedBuilding | null | undefined,
): { latitude: number; longitude: number } | null {
  if (!building) return null;

  const fenceLatitude = asNumber(building.geofence?.latitude);
  const fenceLongitude = asNumber(building.geofence?.longitude);
  if (fenceLatitude !== null && fenceLongitude !== null)
    return { latitude: fenceLatitude, longitude: fenceLongitude };

  const latitude = asNumber(building.latitude);
  const longitude = asNumber(building.longitude);
  return latitude !== null && longitude !== null ? { latitude, longitude } : null;
}
