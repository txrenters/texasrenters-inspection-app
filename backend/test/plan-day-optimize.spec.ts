import { InspectionType, TbpStopStatus } from '@prisma/client';

import type { TechnicianSkillsService } from '../src/admin/technician-skills.service';
import type { PrismaService } from '../src/common/prisma.service';
import { QuarterPlannerService } from '../src/planning/quarter-planner.service';
import type { GoogleRoutesClient } from '../src/routing/google-routes.client';
import type { MapboxDirectionsClient } from '../src/routing/mapbox-directions.client';
import type { OsrmClient } from '../src/routing/osrm.client';

/**
 * Optimize route on the Days view (the office, 2026-10-02): the days stay as
 * grouped, and each is put in the order that drives least from the
 * technician's home -- "just optimize the route and drive time", without the
 * twenty-minute rule a build orders by.
 */

type Point = { latitude: number; longitude: number };

const HOME = { latitude: 29.7, longitude: -95.37 };
/** Three properties on one day, told apart by latitude. */
const AT = { a: 29.71, b: 29.72, c: 29.73 } as const;
const nameOf = (point: Point) =>
  point.latitude === HOME.latitude ? 'home' : (Object.entries(AT).find(([, latitude]) => latitude === point.latitude)?.[0] ?? '?');

/**
 * The least driving from home is home, a, b, c: 100 + 1,300 + 100 seconds. Its
 * a-to-b leg is 21 minutes, over the build's twenty. The only order without a
 * leg over twenty minutes is home, a, c, b: 100 + 1,000 + 1,000, ten minutes
 * more driving. A build takes that one; Optimize route takes the shorter.
 */
const SECONDS: Record<string, Record<string, number>> = {
  home: { a: 100, b: 1500, c: 1500 },
  a: { home: 100, b: 1300, c: 1000 },
  b: { home: 1500, a: 1300, c: 100 },
  c: { home: 1500, a: 1000, b: 1000 },
};

const stopRow = (id: string, at: keyof typeof AT, positionInDay: number | null = null) => ({
  id,
  sequence: 1,
  zone: '1',
  inspectionType: InspectionType.OCCUPIED,
  onSiteMinutes: 30,
  positionInDay,
  propertywareBuilding: { latitude: AT[at], longitude: -95.37 },
});

function build(options: { stops?: ReturnType<typeof stopRow>[]; days?: { date: Date; technicianId: string }[] } = {}) {
  const stops = options.stops ?? [stopRow('s-c', 'c', 2), stopRow('s-a', 'a', 1), stopRow('s-b', 'b', 3)];
  const stopFindMany = jest.fn(({ where }: { where: { positionInDay?: unknown } }) =>
    // The order the plan holds now is asked for with positions; the day's stops without.
    Promise.resolve(where.positionInDay ? stops.filter((stop) => stop.positionInDay !== null) : stops),
  );
  const stopUpdate = jest.fn().mockResolvedValue({});
  const dayUpsert = jest.fn().mockResolvedValue({ id: 'day-1' });
  const dayDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
  const dayFindMany = jest.fn().mockResolvedValue(options.days ?? []);
  const client = {
    tbpQuarterPlan: { findFirst: jest.fn().mockResolvedValue({ maxLegMinutes: 20 }) },
    tbpQuarterPlanStop: { findMany: stopFindMany, update: stopUpdate },
    tbpQuarterPlanAnchor: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
    tbpQuarterPlanDay: {
      findUnique: jest.fn().mockResolvedValue({ id: 'day-1', totalDriveSeconds: 2000, homeDriveSeconds: 100 }),
      findMany: dayFindMany,
      upsert: dayUpsert,
      deleteMany: dayDeleteMany,
    },
    technicianPlanningProfile: {
      findFirst: jest.fn().mockResolvedValue({ homeLatitude: HOME.latitude, homeLongitude: HOME.longitude }),
    },
  };
  const prisma = { ...client, $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(client) } as unknown as PrismaService;
  const mapbox = {
    matrix: jest.fn(async (points: Point[]) => {
      const durations = points.map((from) => points.map((to) => (from === to ? 0 : SECONDS[nameOf(from)]![nameOf(to)]!)));
      return { durations, distances: durations.map((row) => row.map((seconds) => seconds * 15)) };
    }),
  } as unknown as MapboxDirectionsClient;
  const service = new QuarterPlannerService(
    prisma,
    {} as TechnicianSkillsService,
    { matrix: jest.fn().mockResolvedValue(null) } as unknown as GoogleRoutesClient,
    { durations: jest.fn().mockResolvedValue(null) } as unknown as OsrmClient,
    mapbox,
  );
  /** Each stop's place in the day, as written. */
  const order = () =>
    stopUpdate.mock.calls
      .map(([call]) => ({ id: call.where.id as string, at: call.data.positionInDay as number }))
      .sort((left, right) => left.at - right.at)
      .map((entry) => entry.id);
  return { service, stopFindMany, stopUpdate, dayUpsert, dayDeleteMany, dayFindMany, order };
}

const DAY = { date: '2026-12-17', technicianId: 'tech-1' };

describe('optimizing a day’s route', () => {
  it('orders the day from home for the least driving, even through a leg over twenty minutes', async () => {
    const { service, order, dayUpsert } = build();

    const [day] = await service.optimizeDays('org-1', 'plan-1', [DAY]);

    expect(order()).toEqual(['s-a', 's-b', 's-c']);
    // The driving shown is between the properties; the drive from home is apart.
    expect(day).toEqual({
      dayId: 'day-1',
      date: '2026-12-17',
      technicianId: 'tech-1',
      changed: true,
      driveSecondsBefore: 2000,
      driveSecondsAfter: 1400,
      homeDriveSecondsBefore: 100,
      homeDriveSecondsAfter: 100,
    });
    expect(dayUpsert.mock.calls[0][0].update).toMatchObject({ totalDriveSeconds: 1400, homeDriveSeconds: 100 });
  });

  it('is not how a build orders a day: the build keeps to twenty minutes between properties', async () => {
    const { service, order } = build();

    await service.measureDays('org-1', 'plan-1', [DAY]);

    expect(order()).toEqual(['s-a', 's-c', 's-b']);
  });

  it('orders a published day’s booked visits with the rest', async () => {
    const { service, stopFindMany } = build();

    await service.optimizeDays('org-1', 'plan-1', [DAY]);

    const dayStops = stopFindMany.mock.calls.map(([call]) => call.where).find((where) => 'status' in where);
    expect(dayStops?.status).toEqual({ in: [TbpStopStatus.PLANNED, TbpStopStatus.PUBLISHED] });
  });

  it('says nothing changed when the day was already in its best order', async () => {
    const { service } = build({ stops: [stopRow('s-a', 'a', 1), stopRow('s-b', 'b', 2), stopRow('s-c', 'c', 3)] });

    const [day] = await service.optimizeDays('org-1', 'plan-1', [DAY]);

    expect(day?.changed).toBe(false);
  });

  it('removes a day left with nothing on it', async () => {
    const { service, dayDeleteMany, dayUpsert } = build({ stops: [] });

    expect(await service.optimizeDays('org-1', 'plan-1', [DAY])).toEqual([]);
    expect(dayDeleteMany).toHaveBeenCalledWith({
      where: { planId: 'plan-1', organizationId: 'org-1', technicianId: 'tech-1', date: new Date('2026-12-17T00:00:00.000Z') },
    });
    expect(dayUpsert).not.toHaveBeenCalled();
  });

  it('optimizes every day from the day given, and none before it', async () => {
    const { service, dayFindMany } = build({
      days: [{ date: new Date('2026-12-17T00:00:00.000Z'), technicianId: 'tech-1' }],
    });

    const days = await service.optimizeQuarter('org-1', 'plan-1', '2026-12-10');

    expect(dayFindMany.mock.calls[0][0].where).toEqual({
      planId: 'plan-1',
      organizationId: 'org-1',
      date: { gte: new Date('2026-12-10T00:00:00.000Z') },
    });
    expect(days.map((day) => day.date)).toEqual(['2026-12-17']);
  });
});
