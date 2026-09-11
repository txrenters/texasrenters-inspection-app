/**
 * Putting properties on a map.
 *
 * The system stores addresses, not coordinates — Propertyware sends none, and
 * an address is a string, not a place. Turning one into the other is a lookup
 * against an external service, so the rules about *when* that is worth doing,
 * and how much the answer should be trusted, live here where both the backend
 * that performs it and the console that draws it can agree on them.
 */

/**
 * How the coordinate was arrived at.
 *
 * Recorded because these are very different claims. A street match is a
 * statement about a house; a postcode centroid is a statement about a
 * neighbourhood that happens to be shaped like a point. Drawing them the same
 * way would have the map assert something nobody knows, so the precision
 * travels with the point and the console decides how to show it.
 */
export type GeocodePrecision = 'ROOFTOP' | 'INTERPOLATED' | 'CENTROID';

/** Precisions good enough to draw as "this is the property". */
export const TRUSTWORTHY_PRECISIONS: readonly GeocodePrecision[] = ['ROOFTOP', 'INTERPOLATED'];

/**
 * Best to worst. A roof is a place; a centroid is an area with a pin in it.
 *
 * Ranked rather than merely enumerated because the ordering is load-bearing:
 * re-geocoding an address that already has a coordinate is only an improvement
 * if the answer is at least as precise, and nothing enforced that until a
 * backfill proved it.
 */
const PRECISION_RANK: Record<GeocodePrecision, number> = {
  ROOFTOP: 3,
  INTERPOLATED: 2,
  CENTROID: 1,
};

/**
 * Whether a new answer is worth writing over the one already stored.
 *
 * A real incident, on 2026-09-12. A backfill moved every building from the
 * Census geocoder to Google, and for one address -- 3623 Rock Ledge Dr,
 * Richmond -- Google could not find the street and returned the *area centroid*
 * with `location_type: APPROXIMATE`. The backfill wrote it, because it accepted
 * any answer Google gave. The pin moved **7.2 kilometres**, from a Census match
 * on the right street to the middle of Richmond, and that is strictly worse
 * than what it replaced.
 *
 * No stored precision means no coordinate worth keeping, so anything wins:
 * a property placed approximately is on the map, and one placed nowhere is not.
 */
export function isWorthReplacing(
  next: GeocodePrecision,
  current: GeocodePrecision | null | undefined,
): boolean {
  if (!current) return true;
  return PRECISION_RANK[next] >= PRECISION_RANK[current];
}

export interface GeocodableAddress {
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
}

/**
 * The address as one line, in the form a geocoder expects.
 *
 * The ZIP+4 suffix is dropped: the extra four digits identify a delivery
 * point, not a location, and geocoders match *worse* with them attached than
 * without. Whitespace is collapsed because Propertyware data is hand-entered
 * and double spaces are common.
 */
export function geocodableAddress(property: GeocodableAddress): string {
  const postalCode = property.postalCode.trim().split('-')[0] ?? '';
  return [property.addressLine1, property.city, `${property.state} ${postalCode}`.trim()]
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(', ');
}

export interface GeocodedProperty extends GeocodableAddress {
  latitude: number | null;
  longitude: number | null;
  geocodedFor: string | null;
}

/**
 * Whether this property still needs looking up.
 *
 * True when it has never been geocoded, and *also* when its address no longer
 * matches the one the coordinate came from. The second case is the one that
 * matters: a property whose address was corrected would otherwise keep its old
 * pin for ever, and a pin in the wrong place is worse than no pin at all —
 * it sends somebody to the wrong door with confidence.
 */
export function needsGeocoding(property: GeocodedProperty): boolean {
  if (property.latitude === null || property.longitude === null) return true;
  return property.geocodedFor !== geocodableAddress(property);
}

/**
 * A property as the map receives it.
 *
 * Coordinates are numbers because the API converts them at its edge: the
 * columns are decimals, and a Prisma `Decimal` serialises to a string through
 * JSON, which a map cannot plot.
 */
export interface PropertyPosition {
  id: string;
  name: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  latitude: number;
  longitude: number;
  geocodePrecision: GeocodePrecision | null;
}
