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
