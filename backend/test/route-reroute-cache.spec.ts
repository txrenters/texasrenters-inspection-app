import { MAX_DRAWN_ROUTES, RouteService } from '../src/routing/route.service';

/**
 * Asking Google only when the day has changed.
 *
 * Drawing a route is a billed request. The console polls a selected
 * technician's route on a timer, and every poll used to redraw it --
 * a matrix call and a route call -- whether or not anything had moved. These
 * pin down that a still day costs one draw, that a real change costs another,
 * and that a draw which failed is never remembered.
 */

const dec = (value: number) => ({ toNumber: () => value }) as never;
const HOME = { latitude: 29.95, longitude: -95.55 };

/** Noon in Texas. Every test here runs at this instant, whenever it really runs. */
const NOW = Date.parse('2026-09-14T17:00:00.000Z');
const DAY = new Date(NOW);
const MINUTE = 60_000;
const DAY_MS = 24 * 60 * MINUTE;

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

function building(id: string, latitude: number, longitude: number) {
  return {
    id,
    name: `${id} address`,
    addressLine1: `${id} address`,
    city: 'Houston',
    latitude: dec(latitude),
    longitude: dec(longitude),
  };
}

interface Ping {
  latitude: number;
  longitude: number;
  recordedAt: Date;
}

/** A day whose stops, and whose technician's newest position, can change between calls. */
function day(initial: string[]) {
  const state: { stops: string[]; ping: Ping | null } = { stops: initial, ping: null };
  const prisma = {
    inspectionAssignment: {
      findMany: async () =>
        state.stops.map((id, index) => ({
          inspection: {
            id: `inspection-${id}`,
            propertywareBuilding: building(id, 29.9 + index * 0.01, -95.5),
            property: null,
          },
        })),
    },
    // Honours the range it is asked for, as the database would, so a query for
    // the wrong day finds the wrong position here too.
    technicianLocationPing: {
      findFirst: async (args: { where?: { recordedAt?: { gte?: Date; lt?: Date } } }) => {
        const ping = state.ping;
        const range = args.where?.recordedAt;
        if (!ping) return null;
        if (range?.gte && ping.recordedAt < range.gte) return null;
        if (range?.lt && ping.recordedAt >= range.lt) return null;
        return {
          latitude: dec(ping.latitude),
          longitude: dec(ping.longitude),
          recordedAt: ping.recordedAt,
        };
      },
    },
    technicianPlanningProfile: {
      findFirst: async () => ({ homeLatitude: dec(HOME.latitude), homeLongitude: dec(HOME.longitude) }),
    },
  };
  return { prisma, state };
}

type Matrix = (points: unknown[]) => Promise<{ durations: number[][]; distances: number[][] }>;

function google(draws: 'succeed' | 'fail' = 'succeed') {
  const calls = { matrix: 0, route: 0 };
  const matrix: Matrix = async (points) => {
    calls.matrix += 1;
    const size = points.length;
    const grid = Array.from({ length: size }, (_, i) =>
      Array.from({ length: size }, (_, j) => (i === j ? 0 : 600)),
    );
    return { durations: grid, distances: grid };
  };
  const client = {
    configured: true,
    matrix,
    route: async (points: unknown[]) => {
      calls.route += 1;
      if (draws === 'fail') return null;
      const legs = points.slice(1).map(() => ({ durationSeconds: 600, distanceMeters: 5000 }));
      return {
        durationSeconds: legs.length * 600,
        distanceMeters: legs.length * 5000,
        legs,
        geometry: [
          [-95.55, 29.95],
          [-95.5, 29.9],
        ],
      };
    },
  };
  return { client, calls };
}

/**
 * OSRM as production has it: not configured. Each method answers null
 * immediately, exactly as the real client does without `OSRM_URL`, so a failed
 * Google draw falls through to nothing rather than to a network call.
 */
const osrmUnused = {
  configured: false,
  durations: async () => null,
  route: async () => null,
  snappable: async () => null,
} as never;

describe('redrawing a route', () => {
  it('draws once for a day that has not changed', async () => {
    const { prisma } = day(['a', 'b']);
    const { client, calls } = google();
    const service = new RouteService(prisma as never, osrmUnused, client as never);

    await service.planDay('org', 'tech', DAY);
    await service.planDay('org', 'tech', DAY);
    await service.planDay('org', 'tech', DAY);

    // Three polls, one draw.
    expect(calls.route).toBe(1);
    expect(calls.matrix).toBe(1);
  });

  it('draws again when a stop is finished', async () => {
    const { prisma, state } = day(['a', 'b']);
    const { client, calls } = google();
    const service = new RouteService(prisma as never, osrmUnused, client as never);

    await service.planDay('org', 'tech', DAY);
    state.stops = ['b'];
    await service.planDay('org', 'tech', DAY);

    expect(calls.route).toBe(2);
  });

  it('does not remember a draw that failed', async () => {
    /**
     * An outage returns a route with no legs. Caching it would pin that empty
     * route in place for five minutes after Google recovered, which reads on
     * the map exactly like routing being broken.
     */
    const { prisma } = day(['a', 'b']);
    const { client, calls } = google('fail');
    const service = new RouteService(prisma as never, osrmUnused, client as never);

    await service.planDay('org', 'tech', DAY);
    await service.planDay('org', 'tech', DAY);

    expect(calls.route).toBe(2);
  });

  it('keeps separate days separate', async () => {
    const { prisma } = day(['a', 'b']);
    const { client, calls } = google();
    const service = new RouteService(prisma as never, osrmUnused, client as never);

    await service.planDay('org', 'tech', DAY);
    await service.planDay('org', 'tech', new Date(NOW + DAY_MS));

    expect(calls.route).toBe(2);
  });

  it('starts from home and says so', async () => {
    const { prisma } = day(['a']);
    const { client } = google();
    const service = new RouteService(prisma as never, osrmUnused, client as never);

    const route = await service.planDay('org', 'tech', DAY);

    expect(route.originKind).toBe('HOME');
    expect(route.origin?.latitude).toBe(HOME.latitude);
  });

  it('keeps the live route while the handset is quiet', async () => {
    /**
     * Recalculated while somebody is online and sending, and not otherwise. A
     * phone that stops reporting says nothing new about where they are headed.
     */
    const { prisma, state } = day(['a', 'b']);
    const { client, calls } = google();
    const service = new RouteService(prisma as never, osrmUnused, client as never);

    state.ping = { ...HOME, recordedAt: new Date(NOW - MINUTE) };
    expect((await service.planDay('org', 'tech', DAY)).originKind).toBe('LIVE');

    state.ping = { ...HOME, recordedAt: new Date(NOW - 20 * MINUTE) };
    const quiet = await service.planDay('org', 'tech', DAY);

    expect(quiet.originKind).toBe('LAST_KNOWN');
    expect(calls.route).toBe(1);
  });
});

describe('which day a route belongs to', () => {
  it('does not start an earlier day from where somebody is now', async () => {
    const { prisma, state } = day(['a', 'b']);
    const { client } = google();
    const service = new RouteService(prisma as never, osrmUnused, client as never);
    state.ping = { latitude: 29.7, longitude: -95.3, recordedAt: new Date(NOW - MINUTE) };

    const today = await service.planDay('org', 'tech', DAY);
    const earlier = await service.planDay('org', 'tech', new Date(NOW - 2 * DAY_MS));

    // The same position starts today's route, and has no business in the past.
    expect(today.originKind).toBe('LIVE');
    expect(earlier.originKind).toBe('HOME');
  });
});

describe('two callers at once', () => {
  it('share one draw rather than each starting their own', async () => {
    // The route panel and the day summary poll on separate timers; when they
    // coincide on a day needing a redraw, that must still be one request.
    const { prisma } = day(['a', 'b']);
    const { client, calls } = google();
    const service = new RouteService(prisma as never, osrmUnused, client as never);

    await Promise.all([
      service.planDay('org', 'tech', DAY),
      service.planDay('org', 'tech', DAY),
      service.planDay('org', 'tech', DAY),
    ]);

    expect(calls.route).toBe(1);
  });

  it('do not share a draw made for stops that have since changed', async () => {
    /**
     * The first caller's draw is still under way when a stop is finished. The
     * second caller must not be handed the old stops back -- it would remember
     * that route as drawn for the new ones, and a home route never redraws for
     * age, so the finished stop would stay on the map all day.
     */
    const { prisma, state } = day(['a', 'b']);
    const { client, calls } = google();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let underway!: () => void;
    const started = new Promise<void>((resolve) => (underway = resolve));
    const matrix = client.matrix;
    client.matrix = async (points) => {
      underway();
      await gate;
      return matrix(points);
    };
    const service = new RouteService(prisma as never, osrmUnused, client as never);

    const first = service.planDay('org', 'tech', DAY);
    await started;
    state.stops = ['b'];
    const second = service.planDay('org', 'tech', DAY);
    open();

    const [, afterFinishing] = await Promise.all([first, second]);

    expect(afterFinishing.stops.map((stop) => stop.inspectionId)).toEqual(['inspection-b']);
    expect(calls.route).toBe(2);
  });
});

describe('how much is kept', () => {
  it('forgets the longest-untouched day rather than every day ever opened', async () => {
    const { prisma } = day(['a', 'b']);
    const { client, calls } = google();
    const service = new RouteService(prisma as never, osrmUnused, client as never);
    const dayNumber = (n: number) => new Date(NOW + n * DAY_MS);

    for (let n = 1; n <= MAX_DRAWN_ROUTES + 1; n += 1)
      await service.planDay('org', 'tech', dayNumber(n));
    expect(calls.route).toBe(MAX_DRAWN_ROUTES + 1);

    // The newest is still remembered...
    await service.planDay('org', 'tech', dayNumber(MAX_DRAWN_ROUTES + 1));
    expect(calls.route).toBe(MAX_DRAWN_ROUTES + 1);

    // ...and the oldest has made room for it, so it is drawn again.
    await service.planDay('org', 'tech', dayNumber(1));
    expect(calls.route).toBe(MAX_DRAWN_ROUTES + 2);
  });
});
