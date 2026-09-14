import { RouteService } from '../src/routing/route.service';

/**
 * The day so far, kept on the map rather than dropped from it.
 *
 * Finished inspections used to vanish from the route and from the map's list
 * the moment they were submitted, so by the afternoon the panel only ever
 * showed what was left. They are now listed as the day's history and drawn as
 * a grey line under the orange one -- and none of that may send the technician
 * back to a property they have already finished.
 */

const dec = (value: number) => ({ toNumber: () => value }) as never;
const NOW = Date.parse('2026-09-14T17:00:00.000Z');
const DAY = new Date(NOW);
const HOME = { latitude: 29.95, longitude: -95.55 };

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

interface Row {
  id: string;
  status: string;
  submittedAt?: string | null;
  latitude: number;
}

function day(rows: Row[], home: typeof HOME | null = HOME) {
  const seen: { statuses: unknown[] } = { statuses: [] };
  const prisma = {
    inspectionAssignment: {
      findMany: async (args: { where: { inspection: { status: { in: unknown } } } }) => {
        seen.statuses.push(args.where.inspection.status.in);
        return rows.map((row) => ({
          inspection: {
            id: `inspection-${row.id}`,
            status: row.status,
            submittedAt: row.submittedAt ? new Date(row.submittedAt) : null,
            completedAt: null,
            propertywareBuilding: {
              id: row.id,
              name: `${row.id} address`,
              addressLine1: `${row.id} address`,
              city: 'Houston',
              latitude: dec(row.latitude),
              longitude: dec(-95.5),
            },
            property: null,
          },
        }));
      },
    },
    technicianLocationPing: { findFirst: async () => null },
    technicianPlanningProfile: {
      findFirst: async () =>
        home ? { homeLatitude: dec(home.latitude), homeLongitude: dec(home.longitude) } : null,
    },
  };
  return { prisma, seen };
}

function google() {
  const draws: number[][] = [];
  const client = {
    configured: true,
    matrix: async (points: unknown[]) => {
      const grid = Array.from({ length: points.length }, (_, i) =>
        Array.from({ length: points.length }, (_, j) => (i === j ? 0 : 600)),
      );
      return { durations: grid, distances: grid };
    },
    route: async (points: { latitude: number }[]) => {
      draws.push(points.map((point) => point.latitude));
      const legs = points.slice(1).map(() => ({ durationSeconds: 600, distanceMeters: 5000 }));
      return {
        durationSeconds: legs.length * 600,
        distanceMeters: legs.length * 5000,
        legs,
        geometry: points.map((point) => [-95.5, point.latitude] as [number, number]),
      };
    },
  };
  return { client, draws };
}

const osrmUnused = {
  configured: false,
  durations: async () => null,
  route: async () => null,
  snappable: async () => null,
} as never;

const THE_DAY: Row[] = [
  { id: 'left', status: 'SCHEDULED', latitude: 29.93 },
  { id: 'second-done', status: 'TECHNICIAN_SUBMITTED', submittedAt: '2026-09-14T16:10:00Z', latitude: 29.92 },
  { id: 'first-done', status: 'COMPLETED', submittedAt: '2026-09-14T15:05:00Z', latitude: 29.91 },
];

describe('a day with finished stops', () => {
  it('never routes back to a finished stop', async () => {
    const { prisma } = day(THE_DAY);
    const { client } = google();
    const route = await new RouteService(prisma as never, osrmUnused, client as never).planDay(
      'org',
      'tech',
      DAY,
    );

    expect(route.stops.map((stop) => stop.inspectionId)).toEqual(['inspection-left']);
  });

  it('keeps them as the day so far, in the order they were handed in', async () => {
    const { prisma } = day(THE_DAY);
    const { client } = google();
    const route = await new RouteService(prisma as never, osrmUnused, client as never).planDay(
      'org',
      'tech',
      DAY,
    );

    expect(route.history.stops.map((stop) => stop.inspectionId)).toEqual([
      'inspection-first-done',
      'inspection-second-done',
    ]);
  });

  it('draws the drive already done from home, through them in that order', async () => {
    const { prisma } = day(THE_DAY);
    const { client, draws } = google();
    const route = await new RouteService(prisma as never, osrmUnused, client as never).planDay(
      'org',
      'tech',
      DAY,
    );

    expect(draws).toContainEqual([HOME.latitude, 29.91, 29.92]);
    expect(route.history.geometry.length).toBeGreaterThan(1);
  });

  it('does not ask Google for the history again while nothing new is finished', async () => {
    const { prisma } = day(THE_DAY);
    const { client, draws } = google();
    const service = new RouteService(prisma as never, osrmUnused, client as never);

    await service.planDay('org', 'tech', DAY);
    await service.planDay('org', 'tech', DAY);
    await service.planDay('org', 'tech', DAY);

    const historyDraws = draws.filter((points) => points.join() === [HOME.latitude, 29.91, 29.92].join());
    expect(historyDraws).toHaveLength(1);
  });

  it('marks a single finished stop without inventing a line to it', async () => {
    // No home and one stop: nothing to join.
    const { prisma } = day(THE_DAY.slice(0, 2), null);
    const { client } = google();
    const route = await new RouteService(prisma as never, osrmUnused, client as never).planDay(
      'org',
      'tech',
      DAY,
    );

    expect(route.history.stops).toHaveLength(1);
    expect(route.history.geometry).toEqual([]);
  });

  it('still returns the history when the whole day is done', async () => {
    const { prisma } = day(THE_DAY.slice(1));
    const { client } = google();
    const route = await new RouteService(prisma as never, osrmUnused, client as never).planDay(
      'org',
      'tech',
      DAY,
    );

    expect(route.stops).toEqual([]);
    expect(route.history.stops).toHaveLength(2);
  });
});

describe("the map's list of the day", () => {
  it('lists finished stops with when they were handed in, and leaves cancelled work out', async () => {
    const { prisma, seen } = day([
      { id: 'left', status: 'SCHEDULED', latitude: 29.93 },
      { id: 'done', status: 'TECHNICIAN_SUBMITTED', submittedAt: '2026-09-14T15:05:00Z', latitude: 29.91 },
    ]);
    const { client } = google();
    const service = new RouteService(prisma as never, osrmUnused, client as never);

    const [technician] = await service.assignmentsByTechnician('org', DAY);

    // The list sorts by property; which order is not the point here.
    const stops = technician?.stops.map((stop) => [stop.inspectionId, stop.finishedAt]) ?? [];
    expect(stops).toHaveLength(2);
    expect(stops).toEqual(
      expect.arrayContaining([
        ['inspection-left', null],
        ['inspection-done', '2026-09-14T15:05:00.000Z'],
      ]),
    );
    expect(seen.statuses[0]).toEqual(expect.arrayContaining(['TECHNICIAN_SUBMITTED', 'COMPLETED']));
    expect(seen.statuses[0]).not.toContain('CANCELLED');
  });
});
