import { SEGMENT_DEFAULTS } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import type { PrismaService } from '../common/prisma.service';
import { PropertyGeocodingService, parseCensusResponse } from './property-geocoding.service';

/**
 * A real Census reply, trimmed to the fields that are read.
 *
 * `x` is longitude and `y` is latitude — the single most important thing about
 * this format, and the reason these tests exist at all.
 */
const HOUSTON_REPLY = {
  result: {
    addressMatches: [
      {
        matchedAddress: '10054 COPPER HOLLOW LN, HOUSTON, TX, 77044',
        coordinates: { x: -95.18234, y: 29.87451 },
      },
    ],
  },
};

describe('parseCensusResponse', () => {
  it('reads x as longitude and y as latitude', () => {
    // Swapping these puts every Texas property in the Indian Ocean, and the
    // mistake is invisible until somebody opens the map.
    expect(parseCensusResponse(HOUSTON_REPLY)).toEqual({
      latitude: 29.87451,
      longitude: -95.18234,
      precision: 'INTERPOLATED',
      matchedAddress: '10054 COPPER HOLLOW LN, HOUSTON, TX, 77044',
      // Which geocoder answered is now stored, because it is what tells a row
      // that has already been offered a rooftop lookup from one that has not.
      source: 'CENSUS',
    });
  });

  it('never claims rooftop precision', () => {
    // Census interpolates along a street segment. Recording that as ROOFTOP
    // would have the console draw a guess as though it were a survey.
    expect(parseCensusResponse(HOUSTON_REPLY)?.precision).toBe('INTERPOLATED');
  });

  it('returns null when the address matched nothing', () => {
    expect(parseCensusResponse({ result: { addressMatches: [] } })).toBeNull();
  });

  it('rejects the null island', () => {
    // 0,0 is in the Atlantic and is what a geocoder returns when it has
    // nothing. No US address is within a thousand miles of it.
    expect(
      parseCensusResponse({ result: { addressMatches: [{ coordinates: { x: 0, y: 0 } }] } }),
    ).toBeNull();
  });

  it('rejects coordinates outside the possible range', () => {
    expect(
      parseCensusResponse({ result: { addressMatches: [{ coordinates: { x: -95.1, y: 214 } }] } }),
    ).toBeNull();
  });

  it('survives a response shaped like nothing in particular', () => {
    // The service must not throw on a maintenance page or an HTML error body
    // served with a JSON content type.
    for (const body of [null, undefined, {}, { result: {} }, 'not json', { result: { addressMatches: 'x' } }])
      expect(parseCensusResponse(body)).toBeNull();
  });

  it('tolerates a match with no coordinates at all', () => {
    expect(parseCensusResponse({ result: { addressMatches: [{ matchedAddress: 'x' }] } })).toBeNull();
  });
});

/**
 * The circle the console draws, and the number behind it.
 *
 * `positions` stopped being only a list of pins the moment the hours started
 * being computed from a distance. What it says about a property is now the
 * rule a technician is paid by, so the two ways it can be quietly wrong -- a
 * radius that is not the one in force, and a centre that is not where the time
 * is measured -- are worth pinning.
 */
describe('positions', () => {
  const BUILDING = {
    id: 'b-1',
    name: 'Copper Hollow',
    addressLine1: '10054 Copper Hollow Ln',
    city: 'Houston',
    state: 'TX',
    postalCode: '77044',
    latitude: decimal(29.87451),
    longitude: decimal(-95.18234),
    geocodePrecision: 'ROOFTOP',
    geofence: null,
  };

  /** Prisma hands back `Decimal`; the contract is numbers. */
  function decimal(value: number) {
    return { toNumber: () => value };
  }

  // No `planning:read`: these are about the pin and its radius, not the
  // benefit-package facts a reader with that grant is also told.
  const USER = { organizationId: 'org-1', permissions: [] } as unknown as AuthenticatedUser;

  function serviceFor(rows: unknown[]) {
    const prisma = {
      propertywareBuilding: { findMany: jest.fn().mockResolvedValue(rows) },
      // Each property's zone comes from its tenancies (2026-10-01); none here.
      propertywareTenant: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    return new PropertyGeocodingService(prisma);
  }

  it('falls back to the default radius where the office has set none', async () => {
    const [position] = await serviceFor([BUILDING]).positions(USER);

    // Not null, and not zero. Every property has an answer, because a missing
    // radius drawn as nothing would read as "nowhere counts as on site".
    expect(position?.enterRadiusMeters).toBe(SEGMENT_DEFAULTS.enterRadiusMeters);
    expect(position?.exitRadiusMeters).toBe(SEGMENT_DEFAULTS.exitRadiusMeters);
    expect(position?.geofenceMoved).toBe(false);
  });

  it('uses the radius the office set instead of the default', async () => {
    const [position] = await serviceFor([
      {
        ...BUILDING,
        geofence: {
          latitude: null,
          longitude: null,
          enterRadiusMeters: 90,
          exitRadiusMeters: 120,
        },
      },
    ]).positions(USER);

    expect(position?.enterRadiusMeters).toBe(90);
    expect(position?.exitRadiusMeters).toBe(120);
  });

  /**
   * The correction winning over the lookup.
   *
   * Somebody stood at the property and moved the centre. Drawing the circle on
   * the geocoder's pin instead would show a boundary the hours are not
   * measured from — right where a technician disputes them.
   */
  it('draws on the centre the office moved it to, and says it was moved', async () => {
    const [position] = await serviceFor([
      {
        ...BUILDING,
        geofence: {
          latitude: decimal(29.875),
          longitude: decimal(-95.183),
          enterRadiusMeters: 40,
          exitRadiusMeters: 60,
        },
      },
    ]).positions(USER);

    expect(position?.latitude).toBe(29.875);
    expect(position?.longitude).toBe(-95.183);
    expect(position?.geofenceMoved).toBe(true);
  });

  /**
   * A half-written geofence is not a moved one.
   *
   * The radii can be set without ever touching the centre, which is the
   * ordinary case. Treating that row as moved would read a null coordinate as
   * a position and drop the property into the Atlantic at 0,0.
   */
  it('keeps the geocoded pin when only the radius was set', async () => {
    const [position] = await serviceFor([
      {
        ...BUILDING,
        geofence: {
          latitude: null,
          longitude: null,
          enterRadiusMeters: 90,
          exitRadiusMeters: 120,
        },
      },
    ]).positions(USER);

    expect(position?.latitude).toBe(29.87451);
    expect(position?.geofenceMoved).toBe(false);
  });
});

/**
 * Setting how close counts as being there.
 *
 * The table had no writer until now, so every property in the portfolio ran on
 * 40 m in / 60 m out whether that suited a suburban house or a forty-unit
 * complex. The number decides what a technician is paid, so what this refuses
 * matters as much as what it stores.
 */
describe('setting a property geofence', () => {
  const USER = { id: 'admin-1', organizationId: 'org-1', principalType: 'USER' } as AuthenticatedUser;

  function harness(building: unknown = { id: 'b-1' }) {
    const upsert = jest.fn().mockImplementation(({ create, update }) => {
      const data = update ?? create;
      return Promise.resolve({
        enterRadiusMeters: data.enterRadiusMeters,
        exitRadiusMeters: data.exitRadiusMeters,
        latitude: data.latitude === null ? null : { toNumber: () => data.latitude },
        longitude: data.longitude === null ? null : { toNumber: () => data.longitude },
      });
    });
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const auditCreate = jest.fn().mockResolvedValue({});
    const prisma = {
      propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(building) },
      propertyGeofence: { upsert, deleteMany },
      auditLog: { create: auditCreate },
    } as unknown as PrismaService;
    return { service: new PropertyGeocodingService(prisma), upsert, deleteMany, auditCreate };
  }

  it('stores the distances the office chose', async () => {
    const { service, upsert } = harness();

    const result = await service.setGeofence(USER, 'b-1', {
      enterRadiusMeters: 120,
      exitRadiusMeters: 160,
    });

    expect(upsert.mock.calls[0]![0].create).toMatchObject({
      enterRadiusMeters: 120,
      exitRadiusMeters: 160,
      updatedById: 'admin-1',
    });
    expect(result).toMatchObject({ enterRadiusMeters: 120, geofenceMoved: false });
  });

  /**
   * The gap between the two is the hysteresis. Without it a technician near
   * the edge is clocked in and out on noise, and an hour on site becomes a
   * column of one-minute rows.
   */
  it('refuses a departure distance that is not larger than the arrival one', async () => {
    const { service, upsert } = harness();

    await expect(
      service.setGeofence(USER, 'b-1', { enterRadiusMeters: 60, exitRadiusMeters: 60 }),
    ).rejects.toThrow(/larger than the arrival distance/);
    expect(upsert).not.toHaveBeenCalled();
  });

  /** The office asked for 6 m; the handsets cannot measure it. */
  it('refuses a radius tighter than the handsets can measure', async () => {
    const { service } = harness();

    await expect(
      service.setGeofence(USER, 'b-1', { enterRadiusMeters: 6, exitRadiusMeters: 30 }),
    ).rejects.toThrow(/between 10 and 500/);
  });

  /**
   * Half a centre is not a position. Written through, a null longitude beside
   * a real latitude would read as "moved" and put the property at sea.
   */
  it('refuses half a centre', async () => {
    const { service } = harness();

    await expect(
      service.setGeofence(USER, 'b-1', {
        enterRadiusMeters: 40,
        exitRadiusMeters: 60,
        latitude: 29.76,
      }),
    ).rejects.toThrow(/both a latitude and a longitude/);
  });

  it('records a moved centre and says the centre moved', async () => {
    const { service, upsert } = harness();

    const result = await service.setGeofence(USER, 'b-1', {
      enterRadiusMeters: 40,
      exitRadiusMeters: 60,
      latitude: 29.76,
      longitude: -95.37,
    });

    expect(upsert.mock.calls[0]![0].create).toMatchObject({ latitude: 29.76, longitude: -95.37 });
    expect(result.geofenceMoved).toBe(true);
  });

  it('refuses a property in another organization', async () => {
    const { service } = harness(null);

    await expect(
      service.setGeofence(USER, 'b-1', { enterRadiusMeters: 40, exitRadiusMeters: 60 }),
    ).rejects.toThrow(/was not found/);
  });

  /** It decides what somebody is paid, so somebody's name is on it. */
  it('audits the distances and who set them', async () => {
    const { service, auditCreate } = harness();

    await service.setGeofence(USER, 'b-1', { enterRadiusMeters: 90, exitRadiusMeters: 120 });

    expect(auditCreate.mock.calls[0]![0].data).toMatchObject({
      action: 'PROPERTY_GEOFENCE_SET',
      actorUserId: 'admin-1',
      metadata: { enterRadiusMeters: 90, exitRadiusMeters: 120, centreMoved: false },
    });
  });

  /**
   * Clearing deletes the row rather than writing the defaults into it, so
   * "nobody decided" and "somebody chose the default" stay different — a later
   * change to the default should move the first and leave the second.
   */
  it('clears back to the defaults by removing the row', async () => {
    const { service, deleteMany } = harness();

    const result = await service.clearGeofence(USER, 'b-1');

    expect(deleteMany).toHaveBeenCalled();
    expect(result).toEqual({
      enterRadiusMeters: SEGMENT_DEFAULTS.enterRadiusMeters,
      exitRadiusMeters: SEGMENT_DEFAULTS.exitRadiusMeters,
      geofenceMoved: false,
    });
  });
});
