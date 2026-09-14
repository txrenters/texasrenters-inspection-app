import { TechnicianTimelineService } from '../src/technician/technician-timeline.service';

/**
 * The forecast on the map, from the trail and the route together.
 *
 * On 14 September the live map showed Moses twenty-nine minutes into a visit.
 * The per-stop times charged that visit a whole forty minutes more, putting
 * every arrival after it half an hour late, while the day's projected finish
 * counted it as already done. Both now come from one calculation here, so these
 * run it the way the console does: the day's positions, the day's assignments,
 * and whatever route `planDay` hands back.
 */

const dec = (value: number) => ({ toNumber: () => value }) as never;

/** 10:07 in Texas. */
const NOW = Date.parse('2026-09-14T15:07:00.000Z');
const MINUTE = 60_000;
const later = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString();

const A = { latitude: 29.7604, longitude: -95.3698 };
const B = { latitude: 29.7684, longitude: -95.3698 };
const C = { latitude: 29.7764, longitude: -95.3698 };
const ROAD = { latitude: 29.7644, longitude: -95.3698 };

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

function assignment(id: string, building: string, at: { latitude: number; longitude: number }) {
  return {
    inspection: {
      id,
      propertywareBuildingId: building,
      propertywareBuilding: {
        id: building,
        name: `${building} address`,
        latitude: dec(at.latitude),
        longitude: dec(at.longitude),
      },
    },
  };
}

const ping = (at: { latitude: number; longitude: number }, iso: string) => ({
  latitude: dec(at.latitude),
  longitude: dec(at.longitude),
  recordedAt: new Date(iso),
});

/** Arrived at A at 9:38, last reported from there at 9:56. */
const prisma = {
  inspectionAssignment: {
    findMany: async () => [
      assignment('inspection-a', 'building-a', A),
      assignment('inspection-b', 'building-b', B),
      assignment('inspection-c', 'building-c', C),
    ],
  },
  technicianLocationPing: {
    findMany: async () => [
      ping(ROAD, '2026-09-14T14:30:00.000Z'),
      ping(A, '2026-09-14T14:38:00.000Z'),
      ping(A, '2026-09-14T14:56:00.000Z'),
    ],
  },
};

const stop = (inspectionId: string, at: { latitude: number; longitude: number }) => ({
  inspectionId,
  propertyId: inspectionId,
  propertyName: inspectionId,
  addressLine1: inspectionId,
  city: 'Houston',
  ...at,
});

/** The route drawn from where they were last seen: A first, one minute away. */
const ROUTE = {
  technicianId: 'tech',
  origin: { ...A, recordedAt: '2026-09-14T14:56:00.000Z' },
  originKind: 'LAST_KNOWN',
  stops: [stop('inspection-a', A), stop('inspection-b', B), stop('inspection-c', C)],
  legs: [
    { fromStopId: null, toStopId: 'inspection-a', distanceMeters: 100, durationSeconds: 60 },
    {
      fromStopId: 'inspection-a',
      toStopId: 'inspection-b',
      distanceMeters: 900,
      durationSeconds: 420,
    },
    {
      fromStopId: 'inspection-b',
      toStopId: 'inspection-c',
      distanceMeters: 900,
      durationSeconds: 420,
    },
  ],
  totalDistanceMeters: 1900,
  totalDurationSeconds: 900,
  unroutable: [],
  geometry: [
    [A.latitude, A.longitude],
    [B.latitude, B.longitude],
    [C.latitude, C.longitude],
  ],
  originOutsideServiceArea: false,
  airTravel: null,
  estimated: true,
};

const USER = { id: 'dispatcher', organizationId: 'org' } as never;

function service(planDay: () => Promise<unknown>) {
  return new TechnicianTimelineService(prisma as never, { planDay } as never);
}

describe('the forecast for a day under way', () => {
  it('times the day from what is left of the visit under way', async () => {
    const { projection } = await service(async () => ROUTE).dayFor(USER, 'tech', new Date(NOW));

    expect(projection.current).toMatchObject({
      placeId: 'building-a',
      inspectionIds: ['inspection-a'],
      onSiteSeconds: 29 * 60,
      remainingSeconds: 11 * 60,
    });
    // Eleven minutes left at A and seven to drive; then a visit and seven more.
    expect(projection.arrivals.map((a) => [a.inspectionId, a.arriveAt])).toEqual([
      ['inspection-b', later(18)],
      ['inspection-c', later(65)],
    ]);
    expect(projection.stopsRemaining).toBe(2);
  });

  it('finishes one visit after the last arrival', async () => {
    const { projection } = await service(async () => ROUTE).dayFor(USER, 'tech', new Date(NOW));

    expect(projection.projectedFinishAt).toBe(later(65 + 40));
  });
});

describe('the forecast for any other day', () => {
  it('gives no arrivals and no finish, because both count from now', async () => {
    const { projection } = await service(async () => ROUTE).dayFor(
      USER,
      'tech',
      new Date(NOW + 2 * 24 * 60 * MINUTE),
    );

    expect(projection.arrivals).toEqual([]);
    expect(projection.current).toBeNull();
    expect(projection.projectedFinishAt).toBeNull();
  });
});

describe('the forecast without a route', () => {
  it('still counts the visit under way and the stops left', async () => {
    // The router threw. There is no order to put arrivals in, but the day is
    // still there to count.
    const { projection } = await service(async () => {
      throw new Error('routing unavailable');
    }).dayFor(USER, 'tech', new Date(NOW));

    expect(projection.current?.remainingSeconds).toBe(11 * 60);
    expect(projection.arrivals).toEqual([]);
    expect(projection.stopsRemaining).toBe(2);
    expect(projection.projectedFinishAt).not.toBeNull();
  });
});
