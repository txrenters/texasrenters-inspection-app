import { RouteService } from '../src/routing/route.service';

/**
 * Which router timed a route, carried on the route.
 *
 * The console printed "estimated from speed limits, without traffic" under
 * every route, written when OSRM was the only router. Google became the one
 * answering in production -- timing every drive against traffic -- and the
 * caveat stayed, false on every route anybody saw. These pin the route to
 * saying which router actually drew it.
 */

const dec = (value: number) => ({ toNumber: () => value }) as never;
const NOW = Date.parse('2026-09-14T17:00:00.000Z');
const DAY = new Date(NOW);

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Two stops, and a technician who has not reported today, so the day starts from home. */
const prisma = {
  inspectionAssignment: {
    findMany: async () =>
      ['a', 'b'].map((id, index) => ({
        inspection: {
          id: `inspection-${id}`,
          propertywareBuilding: {
            id,
            name: `${id} address`,
            addressLine1: `${id} address`,
            city: 'Houston',
            latitude: dec(29.9 + index * 0.01),
            longitude: dec(-95.5),
          },
          property: null,
        },
      })),
  },
  technicianLocationPing: { findFirst: async () => null },
  technicianPlanningProfile: {
    findFirst: async () => ({ homeLatitude: dec(29.95), homeLongitude: dec(-95.55) }),
  },
};

const grid = (points: unknown[]) =>
  Array.from({ length: points.length }, (_, i) =>
    Array.from({ length: points.length }, (_, j) => (i === j ? 0 : 600)),
  );

const drive = (points: unknown[]) => ({
  durationSeconds: (points.length - 1) * 600,
  distanceMeters: (points.length - 1) * 5000,
  legs: points.slice(1).map(() => ({ durationSeconds: 600, distanceMeters: 5000 })),
  geometry: [
    [-95.55, 29.95],
    [-95.5, 29.9],
  ] as [number, number][],
});

/**
 * Google and OSRM as a deployment might have them. `fails` is configured and
 * not answering -- a quota, an outage, a lapsed key.
 */
function routers(google: 'answers' | 'fails' | 'unconfigured', osrm: 'answers' | 'unconfigured') {
  const calls = { google: 0 };
  const googleClient = {
    configured: google !== 'unconfigured',
    matrix: async (points: unknown[]) =>
      google === 'answers' ? { durations: grid(points), distances: grid(points) } : null,
    route: async (points: unknown[]) => {
      calls.google += 1;
      return google === 'answers' ? drive(points) : null;
    },
  };
  const osrmClient = {
    configured: osrm === 'answers',
    durations: async (points: unknown[]) => (osrm === 'answers' ? grid(points) : null),
    route: async (points: unknown[]) => (osrm === 'answers' ? drive(points) : null),
    snappable: async (points: unknown[]) => (osrm === 'answers' ? points.map(() => true) : null),
  };
  const service = new RouteService(prisma as never, osrmClient as never, googleClient as never);
  return { service, calls };
}

describe('which router timed a route', () => {
  it('says Google, with traffic, when Google drew it', async () => {
    const route = await routers('answers', 'unconfigured').service.planDay('org', 'tech', DAY);

    expect(route.legs.length).toBeGreaterThan(0);
    expect(route.source).toBe('GOOGLE_TRAFFIC');
  });

  it('says free-flow when Google did not answer and the fallback drew it', async () => {
    const route = await routers('fails', 'answers').service.planDay('org', 'tech', DAY);

    expect(route.legs.length).toBeGreaterThan(0);
    expect(route.source).toBe('OSRM_FREE_FLOW');
  });

  it('says free-flow on a deployment with no Google key at all', async () => {
    const route = await routers('unconfigured', 'answers').service.planDay('org', 'tech', DAY);

    expect(route.source).toBe('OSRM_FREE_FLOW');
  });

  it('claims no source for a route nothing drew', async () => {
    // No times, so nothing to describe -- and a caveat beside no times reads
    // as a claim about a drive that does not exist.
    const route = await routers('fails', 'unconfigured').service.planDay('org', 'tech', DAY);

    expect(route.legs).toEqual([]);
    expect(route.source).toBeNull();
  });

  it('keeps the source on a route reused rather than redrawn', async () => {
    const { service, calls } = routers('answers', 'unconfigured');

    await service.planDay('org', 'tech', DAY);
    const reused = await service.planDay('org', 'tech', DAY);

    expect(calls.google).toBe(1);
    expect(reused.source).toBe('GOOGLE_TRAFFIC');
  });
});
