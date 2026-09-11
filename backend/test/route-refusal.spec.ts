import { RouteService } from '../src/routing/route.service';

/**
 * What the router does when a coordinate is not somewhere it can drive.
 *
 * These exist because the interesting failure here is not an error -- it is a
 * confident wrong answer. OSRM, asked to route from a point outside its
 * extract, does not refuse: it snaps to the nearest road it knows, however far
 * away, and reports `Ok`. A technician in the Philippines was relocated to a
 * road in east Texas and the console drew a four-hour drive to Houston.
 *
 * So every case below asserts on what is *absent* -- no legs, no geometry, no
 * distance -- as much as on the flag. A route that is merely mislabelled but
 * still carries fabricated numbers would pass a flag-only test.
 */

/** Prisma hands back `Decimal`; only `toNumber` is ever called on it. */
const dec = (value: number) => ({ toNumber: () => value }) as never;

const HOUSTON = { latitude: 29.958784, longitude: -95.574255 };
const MARIPOSA = { latitude: 29.866277, longitude: -95.200871 };
/** Mindanao. The position that started all this. */
const PHILIPPINES = { latitude: 8.48164, longitude: 123.806345 };

function building(id: string, at: { latitude: number; longitude: number }) {
  return {
    id,
    name: `${id} address`,
    addressLine1: `${id} address`,
    city: 'Houston',
    latitude: dec(at.latitude),
    longitude: dec(at.longitude),
  };
}

function prismaStub(
  buildings: { id: string; at: { latitude: number; longitude: number } }[],
  position: { latitude: number; longitude: number } | null,
) {
  return {
    inspectionAssignment: {
      findMany: async () =>
        buildings.map((entry) => ({
          inspection: {
            id: `inspection-${entry.id}`,
            propertywareBuilding: building(entry.id, entry.at),
            property: null,
          },
        })),
    },
    technicianLocationPing: {
      findFirst: async () =>
        position
          ? {
              latitude: dec(position.latitude),
              longitude: dec(position.longitude),
              recordedAt: new Date('2026-08-28T02:00:00.000Z'),
            }
          : null,
    },
  } as never;
}

const DAY = new Date('2026-08-28T00:00:00.000Z');

describe('a start OSRM will not accept', () => {
  it('reports no route rather than one from a substituted point', async () => {
    const osrm = {
      // What the guard now produces: the matrix refuses the whole request.
      durations: async () => null,
      // The origin is index 0, and it is the one off the network.
      snappable: async () => [false, true],
      route: async () => null,
    };

    const route = await new RouteService(
      prismaStub([{ id: 'mist-ln', at: HOUSTON }], PHILIPPINES),
      osrm as never,
      // Google unconfigured, so these keep exercising the OSRM path they were
      // written for -- the teleport guard is specific to it.
      { configured: false } as never,
    ).planDay('org', 'tech', DAY);

    expect(route.originOutsideServiceArea).toBe(true);

    // The position is still reported -- it is a fact about the technician, and
    // hiding it would leave the console unable to say why there is no route.
    expect(route.origin?.latitude).toBeCloseTo(PHILIPPINES.latitude);

    // And nothing invented. This is the assertion that would have failed
    // before the guard existed: the old code returned legs and a distance.
    expect(route.legs).toEqual([]);
    expect(route.geometry).toEqual([]);
    expect(route.totalDistanceMeters).toBe(0);
    expect(route.totalDurationSeconds).toBe(0);

    // The day is still known; only its order is not.
    expect(route.stops).toHaveLength(1);

    // How far away they actually are -- a real, computable fact, and the only
    // one available once driving is off the table.
    expect(route.airTravel?.inspectionId).toBe('inspection-mist-ln');
    // Mindanao to Houston is roughly 13,700 km.
    expect(route.airTravel!.distanceMeters / 1000).toBeGreaterThan(13_000);
    expect(route.airTravel!.distanceMeters / 1000).toBeLessThan(14_500);
  });

  it('carries no flight time, because there is none to carry', async () => {
    const osrm = {
      durations: async () => null,
      snappable: async () => [false, true],
      route: async () => null,
    };

    const route = await new RouteService(
      prismaStub([{ id: 'mist-ln', at: HOUSTON }], PHILIPPINES),
      osrm as never,
      // Google unconfigured, so these keep exercising the OSRM path they were
      // written for -- the teleport guard is specific to it.
      { configured: false } as never,
    ).planDay('org', 'tech', DAY);

    // Distance is a fact about the Earth. A duration would need airports,
    // schedules and connections this system does not have, and deriving one
    // from distance is the same fabrication the snapping guard exists to stop.
    expect(Object.keys(route.airTravel ?? {})).toEqual(['inspectionId', 'distanceMeters']);
  });

  it('does not blame the position when OSRM is simply down', async () => {
    // `snappable` answering null means "cannot tell", and telling the office
    // their technician is off the map during an outage would be the same class
    // of confident wrong answer this whole guard exists to prevent.
    const osrm = {
      durations: async () => null,
      snappable: async () => null,
      route: async () => null,
    };

    const route = await new RouteService(
      prismaStub([{ id: 'mist-ln', at: HOUSTON }], HOUSTON),
      osrm as never,
      // Google unconfigured, so these keep exercising the OSRM path they were
      // written for -- the teleport guard is specific to it.
      { configured: false } as never,
    ).planDay('org', 'tech', DAY);

    expect(route.originOutsideServiceArea).toBe(false);
    expect(route.legs).toEqual([]);
    expect(route.stops).toHaveLength(1);
  });
});

describe('a stop OSRM will not accept', () => {
  it('sets that one aside and routes the rest', async () => {
    let matrixCalls = 0;
    const osrm = {
      durations: async () => {
        matrixCalls += 1;
        // First call includes the bad stop and is refused; the retry, after it
        // has been removed, succeeds.
        if (matrixCalls === 1) return null;
        return [
          [0, 600],
          [600, 0],
        ];
      },
      // Origin fine, first stop off the network, second stop fine.
      snappable: async () => [true, false, true],
      route: async () => ({
        distanceMeters: 9000,
        durationSeconds: 600,
        legs: [{ distanceMeters: 9000, durationSeconds: 600 }],
        geometry: [[-95.574255, 29.958784]] as [number, number][],
      }),
    };

    const route = await new RouteService(
      prismaStub(
        [
          { id: 'in-the-gulf', at: { latitude: 27.5, longitude: -93.0 } },
          { id: 'mariposa', at: MARIPOSA },
        ],
        HOUSTON,
      ),
      osrm as never,
      // Google unconfigured, so these keep exercising the OSRM path they were
      // written for -- the teleport guard is specific to it.
      { configured: false } as never,
    ).planDay('org', 'tech', DAY);

    expect(matrixCalls).toBe(2);
    expect(route.originOutsideServiceArea).toBe(false);

    // The good stop is routed...
    expect(route.stops.map((stop) => stop.inspectionId)).toEqual(['inspection-mariposa']);
    expect(route.totalDurationSeconds).toBe(600);

    // ...and the bad one is carried with a reason rather than vanishing, which
    // is the difference between "you have two inspections" and a route of one.
    expect(route.unroutable).toEqual([
      {
        inspectionId: 'inspection-in-the-gulf',
        propertyName: 'in-the-gulf address',
        reason: 'OUTSIDE_SERVICE_AREA',
      },
    ]);
  });

  it('has no route left when every stop is off the network', async () => {
    const osrm = {
      durations: async () => null,
      snappable: async () => [true, false],
      route: async () => null,
    };

    const route = await new RouteService(
      prismaStub([{ id: 'in-the-gulf', at: { latitude: 27.5, longitude: -93.0 } }], HOUSTON),
      osrm as never,
      // Google unconfigured, so these keep exercising the OSRM path they were
      // written for -- the teleport guard is specific to it.
      { configured: false } as never,
    ).planDay('org', 'tech', DAY);

    expect(route.stops).toEqual([]);
    expect(route.legs).toEqual([]);
    expect(route.unroutable).toHaveLength(1);
    // The origin was fine. Saying otherwise would point the office at the
    // wrong thing to fix.
    expect(route.originOutsideServiceArea).toBe(false);
  });
});
