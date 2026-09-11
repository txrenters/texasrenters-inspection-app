import { describe, expect, it } from 'vitest';

import {
  geocodableAddress,
  isWorthReplacing,
  needsGeocoding,
} from '../src/contracts/property-location.js';

const HOUSTON = {
  addressLine1: '10054 Copper Hollow Ln',
  city: 'Houston',
  state: 'TX',
  postalCode: '77044-5594',
};

describe('geocodableAddress', () => {
  it('drops the ZIP+4 suffix', () => {
    // The extra four digits identify a delivery point rather than a place, and
    // geocoders match worse with them attached than without.
    expect(geocodableAddress(HOUSTON)).toBe('10054 Copper Hollow Ln, Houston, TX 77044');
  });

  it('keeps a plain five-digit postcode', () => {
    expect(geocodableAddress({ ...HOUSTON, postalCode: '77044' })).toBe(
      '10054 Copper Hollow Ln, Houston, TX 77044',
    );
  });

  it('collapses the double spaces that hand-entered data is full of', () => {
    expect(
      geocodableAddress({ ...HOUSTON, addressLine1: '10054  Copper   Hollow Ln ' }),
    ).toBe('10054 Copper Hollow Ln, Houston, TX 77044');
  });

  it('omits an empty postcode rather than leaving a dangling state', () => {
    expect(geocodableAddress({ ...HOUSTON, postalCode: '' })).toBe(
      '10054 Copper Hollow Ln, Houston, TX',
    );
  });
});

describe('needsGeocoding', () => {
  const placed = {
    ...HOUSTON,
    latitude: 29.9,
    longitude: -95.2,
    geocodedFor: geocodableAddress(HOUSTON),
  };

  it('is true when the property has never been looked up', () => {
    expect(needsGeocoding({ ...placed, latitude: null, longitude: null, geocodedFor: null })).toBe(
      true,
    );
  });

  it('is true when only one half of the coordinate is present', () => {
    expect(needsGeocoding({ ...placed, longitude: null })).toBe(true);
  });

  it('is false once the coordinate matches the current address', () => {
    expect(needsGeocoding(placed)).toBe(false);
  });

  it('is true again when the address changes underneath the coordinate', () => {
    // The case this whole field exists for: a corrected address must not keep
    // pointing at the old house. A wrong pin is worse than no pin — it sends
    // somebody to the wrong door with confidence.
    expect(needsGeocoding({ ...placed, addressLine1: '10056 Copper Hollow Ln' })).toBe(true);
  });

  it('does not consider a ZIP+4 correction a change', () => {
    // Normalisation happens on both sides, so adding the +4 to a stored
    // address must not trigger a pointless re-lookup of every property.
    expect(needsGeocoding({ ...placed, postalCode: '77044' })).toBe(false);
  });
});

describe('replacing a coordinate that is already there', () => {
  /**
   * A real incident, 2026-09-12. A backfill moved every building from the
   * Census geocoder to Google. For 3623 Rock Ledge Dr, Richmond, Google could
   * not find the street and returned the *area centroid*. The backfill wrote
   * it, because it accepted any answer Google gave, and the pin moved 7.2km
   * onto the middle of Richmond — off a perfectly good Census match on the
   * right street.
   */
  it('refuses a centroid over an interpolated street match', () => {
    expect(isWorthReplacing('CENTROID', 'INTERPOLATED')).toBe(false);
  });

  it('refuses a centroid over a rooftop', () => {
    expect(isWorthReplacing('CENTROID', 'ROOFTOP')).toBe(false);
  });

  it('refuses an interpolated answer over a rooftop', () => {
    // Re-running a backfill must not walk a good pin back onto the road.
    expect(isWorthReplacing('INTERPOLATED', 'ROOFTOP')).toBe(false);
  });

  it('accepts an improvement', () => {
    expect(isWorthReplacing('ROOFTOP', 'INTERPOLATED')).toBe(true);
    expect(isWorthReplacing('INTERPOLATED', 'CENTROID')).toBe(true);
  });

  it('accepts the same precision, so a moved address still updates', () => {
    // A property whose address was corrected needs its coordinate rewritten
    // even when the new answer is no more precise than the old one.
    expect(isWorthReplacing('ROOFTOP', 'ROOFTOP')).toBe(true);
  });

  it('accepts anything when nothing is stored', () => {
    // A property placed approximately is on the map; one placed nowhere is not.
    expect(isWorthReplacing('CENTROID', null)).toBe(true);
    expect(isWorthReplacing('CENTROID', undefined)).toBe(true);
  });
});
