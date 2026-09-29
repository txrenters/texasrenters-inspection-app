import { propertyPosition } from './property-position';

/**
 * One answer to "where is this property", for every map and for the planner.
 *
 * The office asked for the technician map and the quarter's maps to be one
 * map: "same geocoding, same Venn diagram". They were not. The technician map
 * put a property at its geofence centre when the office had corrected it; the
 * planner and the plan's own pins used the raw geocode. So a corrected
 * property sat in two places, and the planner grouped it by the one the office
 * had overruled.
 */

/** What a Prisma `Decimal` looks like to this code. */
const decimal = (value: number) => ({ toNumber: () => value });

describe('where a property is', () => {
  it('is the geocoded point when nobody has corrected it', () => {
    expect(propertyPosition({ latitude: decimal(29.76), longitude: decimal(-95.37) })).toEqual({
      latitude: 29.76,
      longitude: -95.37,
    });
  });

  /** The rule itself: somebody standing at the property beats an address lookup. */
  it('is the office’s corrected centre when there is one', () => {
    expect(
      propertyPosition({
        latitude: decimal(29.76),
        longitude: decimal(-95.37),
        geofence: { latitude: decimal(29.7612), longitude: decimal(-95.3688) },
      }),
    ).toEqual({ latitude: 29.7612, longitude: -95.3688 });
  });

  /**
   * A geofence can exist with only its radii changed. Its centre is then
   * empty, and that is not a correction -- it must not move the property to
   * nowhere.
   */
  it('keeps the geocoded point when only the radii were changed', () => {
    expect(
      propertyPosition({
        latitude: decimal(29.76),
        longitude: decimal(-95.37),
        geofence: { latitude: null, longitude: null },
      }),
    ).toEqual({ latitude: 29.76, longitude: -95.37 });
  });

  it('does not take half a correction', () => {
    expect(
      propertyPosition({
        latitude: decimal(29.76),
        longitude: decimal(-95.37),
        geofence: { latitude: decimal(29.7612), longitude: null },
      }),
    ).toEqual({ latitude: 29.76, longitude: -95.37 });
  });

  it('is nowhere for a property that has never been geocoded', () => {
    expect(propertyPosition({ latitude: null, longitude: null })).toBeNull();
    expect(propertyPosition(null)).toBeNull();
    expect(propertyPosition(undefined)).toBeNull();
  });

  /** A corrected centre still places a property the geocoder never found. */
  it('is the corrected centre even without a geocode', () => {
    expect(
      propertyPosition({
        latitude: null,
        longitude: null,
        geofence: { latitude: decimal(29.7612), longitude: decimal(-95.3688) },
      }),
    ).toEqual({ latitude: 29.7612, longitude: -95.3688 });
  });

  /** Numbers, not Decimals: a Decimal serialises to a string and plots nothing. */
  it('answers in plain numbers', () => {
    const at = propertyPosition({ latitude: decimal(29.76), longitude: decimal(-95.37) });

    expect(typeof at?.latitude).toBe('number');
    expect(typeof at?.longitude).toBe('number');
  });
});
