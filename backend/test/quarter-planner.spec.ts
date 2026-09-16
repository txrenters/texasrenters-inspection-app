import { DriveTimeSource, InspectionType, PlanOriginKind, TbpPlanStatus, TbpStopStatus } from '@prisma/client';
import { plannedVisitDaysOfQuarter, workingDaysOfQuarter } from '@texasrenters/shared';

import type { TechnicianSkillsService } from '../src/admin/technician-skills.service';
import type { PrismaService } from '../src/common/prisma.service';
import type { GoogleRoutesClient } from '../src/routing/google-routes.client';
import type { OsrmClient } from '../src/routing/osrm.client';
import { QuarterPlannerService, routingSettings } from '../src/planning/quarter-planner.service';

interface StopRow {
  id: string;
  sequence: number;
  latitude: number | null;
  longitude: number | null;
  inspectionType?: InspectionType;
  previousTechnicianId?: string | null;
  /** `YYYY-MM-DD`, as a coordinator or an earlier run left it. */
  scheduledOn?: string | null;
  assignedTechnicianId?: string | null;
  scheduleOverriddenAt?: Date | null;
  technicianOverriddenAt?: Date | null;
  onSiteMinutes?: number | null;
  onSiteMinutesOverriddenAt?: Date | null;
  /** As the tenant report writes it. */
  zone?: string | null;
}

interface Point {
  latitude: number;
  longitude: number;
}

/** Houston-ish coordinates, so distances are realistic rather than degenerate. */
const stop = (id: string, sequence: number, offset = 0, extra: Partial<StopRow> = {}): StopRow => ({
  id,
  sequence,
  latitude: 29.76 + offset * 0.01,
  longitude: -95.37,
  ...extra,
});

/**
 * Every working day of Q4 2026 except the first, as closed days.
 *
 * The routing tests need several stops on *one* day, and the planner
 * deliberately spreads a quarter across all of its working days -- so with
 * sixty-odd of them two stops land weeks apart. Closing the office for the rest
 * of the quarter is the honest way to say "one working day".
 */
const onlyTheFirstWorkingDay = () => workingDaysOfQuarter({ year: 2026, quarter: 4 }).slice(1);

const PLAN = {
  id: 'plan-1',
  status: TbpPlanStatus.DRAFT as TbpPlanStatus,
  quarterYear: 2026,
  quarterNumber: 4,
  occupiedVisitMinutes: 30,
  hvacVisitMinutes: 45,
  maxOnSiteMinutes: 360,
  maxDriveMinutes: 90,
  minStopsPerDay: 9,
  holidays: [] as string[],
};

const build = (
  stops: StopRow[],
  options: {
    plan?: Partial<typeof PLAN>;
    /**
     * Planning profiles. On the benefit-package crew in the order given, unless
     * `tbpZoneOrder` says otherwise -- null is not on the crew.
     */
    technicians?: {
      technicianId: string;
      isPlannable: boolean;
      homeLatitude?: number | null;
      homeLongitude?: number | null;
      tbpZoneOrder?: number | null;
    }[];
    qualified?: string[];
    qualifiedFor?: Partial<Record<InspectionType, string[]>>;
    /** Seconds between two points, as Google would say. Null: Google is not configured. */
    googleSeconds?: ((from: Point, to: Point) => number) | null;
    osrmDurations?: number[][] | null;
  } = {},
) => {
  const technicians = options.technicians ?? [{ technicianId: 'tech-1', isPlannable: true }];
  const qualified = options.qualified ?? technicians.map((row) => row.technicianId);
  const profiles = technicians.map((row, index) => ({
    homeLatitude: null,
    homeLongitude: null,
    tbpZoneOrder: index + 1,
    ...row,
  }));

  const dayCreate = jest.fn().mockResolvedValue({});
  const dayUpsert = jest.fn().mockResolvedValue({});
  const stopUpdate = jest.fn().mockResolvedValue({});
  const stopUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
  const dayDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const planUpdate = jest.fn().mockResolvedValue({});

  const client = {
    tbpQuarterPlan: {
      findFirst: jest.fn().mockResolvedValue({ ...PLAN, ...options.plan }),
      update: planUpdate,
    },
    tbpQuarterPlanStop: {
      findMany: jest.fn().mockResolvedValue(
        stops.map((row) => ({
          id: row.id,
          sequence: row.sequence,
          zone: row.zone === undefined ? '1' : row.zone,
          inspectionType: row.inspectionType ?? InspectionType.OCCUPIED,
          previousTechnicianId: row.previousTechnicianId ?? null,
          scheduledOn: row.scheduledOn ? new Date(`${row.scheduledOn}T00:00:00.000Z`) : null,
          assignedTechnicianId: row.assignedTechnicianId ?? null,
          scheduleOverriddenAt: row.scheduleOverriddenAt ?? null,
          technicianOverriddenAt: row.technicianOverriddenAt ?? null,
          onSiteMinutes: row.onSiteMinutes ?? null,
          onSiteMinutesOverriddenAt: row.onSiteMinutesOverriddenAt ?? null,
          propertywareBuilding:
            row.latitude === null ? null : { latitude: row.latitude, longitude: row.longitude },
        })),
      ),
      updateMany: stopUpdateMany,
      update: stopUpdate,
      count: jest.fn().mockResolvedValue(0),
    },
    technicianPlanningProfile: {
      // As the database would answer the crew query: plannable, on the crew, in order.
      findMany: jest.fn().mockResolvedValue(
        profiles
          .filter((row) => row.isPlannable && row.tbpZoneOrder !== null)
          .sort((left, right) => left.tbpZoneOrder! - right.tbpZoneOrder!),
      ),
      findFirst: jest.fn(({ where }: { where: { technicianId: string } }) =>
        Promise.resolve(profiles.find((row) => row.technicianId === where.technicianId) ?? null),
      ),
    },
    tbpQuarterPlanDay: { deleteMany: dayDeleteMany, create: dayCreate, upsert: dayUpsert },
    userProfile: {
      findMany: jest.fn().mockResolvedValue(
        technicians.map((row) => ({ id: row.technicianId, displayName: `Name of ${row.technicianId}` })),
      ),
    },
  };

  const prisma = {
    ...client,
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  } as unknown as PrismaService;

  const skills = {
    qualificationCalendar: jest.fn((_org: string, type: InspectionType, dates: Date[]) =>
      Promise.resolve(
        new Map(
          dates.map((date) => [
            date.toISOString().slice(0, 10),
            (options.qualifiedFor?.[type] ?? qualified).map((technicianId) => ({
              technicianId,
              displayName: technicianId,
              preferredHeld: 0,
              preferredTotal: 0,
            })),
          ]),
        ),
      ),
    ),
  } as unknown as TechnicianSkillsService;

  const seconds = options.googleSeconds;
  const google = {
    matrix: jest.fn((points: Point[]) =>
      Promise.resolve(
        seconds
          ? {
              durations: points.map((from) => points.map((to) => (from === to ? 0 : seconds(from, to)))),
              distances: points.map((from) => points.map((to) => (from === to ? 0 : seconds(from, to) * 10))),
            }
          : null,
      ),
    ),
  } as unknown as GoogleRoutesClient;
  const osrm = {
    durations: jest.fn().mockResolvedValue(options.osrmDurations ?? null),
  } as unknown as OsrmClient;

  return {
    service: new QuarterPlannerService(prisma, skills, google, osrm),
    dayCreate,
    dayUpsert,
    stopFindMany: client.tbpQuarterPlanStop.findMany,
    stopUpdate,
    stopUpdateMany,
    dayDeleteMany,
    planUpdate,
    google,
    osrm,
    skills,
  };
};

/** Every planned day of Q4 2026 but these, as closed days: the only days left to plan on. */
const onlyOn = (...dates: string[]) =>
  plannedVisitDaysOfQuarter({ year: 2026, quarter: 4 }).filter((date) => !dates.includes(date));

const updateFor = (stopUpdate: jest.Mock, id: string) =>
  stopUpdate.mock.calls.find((call) => call[0].where.id === id)?.[0].data as Record<string, unknown> | undefined;

/** Five minutes between any two stops. */
const fiveMinutes = () => 300;

/** After a coordinator moves a visit or changes its length, from its window. */
describe('measuring days again after a coordinator’s change', () => {
  const onDay = (id: string, sequence: number, offset: number) => ({
    id,
    sequence,
    zone: '1',
    inspectionType: InspectionType.OCCUPIED,
    onSiteMinutes: 45,
    propertywareBuilding: { latitude: 29.76 + offset * 0.01, longitude: -95.37 },
  });

  it('measures the day a visit joined from the visits on it now, and removes the day it left empty', async () => {
    const { service, stopFindMany, dayUpsert, dayDeleteMany, stopUpdate } = build([], { googleSeconds: fiveMinutes });
    stopFindMany.mockResolvedValueOnce([onDay('s1', 1, 0), onDay('s2', 2, 1)]).mockResolvedValueOnce([]);

    await service.measureDays('org-1', 'plan-1', [
      { date: '2026-10-02', technicianId: 'tech-1' },
      { date: '2026-10-01', technicianId: 'tech-2' },
    ]);

    expect(dayUpsert).toHaveBeenCalledTimes(1);
    const upsert = dayUpsert.mock.calls[0][0];
    expect(upsert.where).toEqual({
      planId_technicianId_date: { planId: 'plan-1', technicianId: 'tech-1', date: new Date('2026-10-02T00:00:00.000Z') },
    });
    expect(upsert.create).toMatchObject({ organizationId: 'org-1', stopCount: 2, onSiteMinutes: 90, totalDriveSeconds: 300 });
    expect(upsert.update).toMatchObject({ stopCount: 2, onSiteMinutes: 90, totalDriveSeconds: 300 });
    expect([updateFor(stopUpdate, 's1')?.positionInDay, updateFor(stopUpdate, 's2')?.positionInDay].sort()).toEqual([1, 2]);
    expect(dayDeleteMany).toHaveBeenCalledWith({
      where: { planId: 'plan-1', organizationId: 'org-1', technicianId: 'tech-2', date: new Date('2026-10-01T00:00:00.000Z') },
    });
  });

  it('routes a measured day from the technician’s home', async () => {
    const { service, stopFindMany, dayUpsert } = build([], {
      technicians: [{ technicianId: 'tech-1', isPlannable: true, homeLatitude: 29.7, homeLongitude: -95.37 }],
      googleSeconds: fiveMinutes,
    });
    stopFindMany.mockResolvedValueOnce([onDay('s1', 1, 0)]);

    await service.measureDays('org-1', 'plan-1', [{ date: '2026-10-02', technicianId: 'tech-1' }]);

    // One property: nothing to drive between, and the drive from home shown apart.
    expect(dayUpsert.mock.calls[0][0].create).toMatchObject({
      originKind: PlanOriginKind.HOME,
      homeDriveSeconds: 300,
      totalDriveSeconds: 0,
    });
  });
});

describe('routing a draft quarter', () => {
  it('gives every stop a day, a technician and a position', async () => {
    const { service, stopUpdate } = build([stop('s1', 1), stop('s2', 2, 1), stop('s3', 3, 2)]);

    const summary = await service.route('org-1', 'plan-1');

    expect(summary.placed).toBe(3);
    expect(summary.unplaced).toEqual([]);
    for (const id of ['s1', 's2', 's3']) expect(updateFor(stopUpdate, id)?.positionInDay).toBe(1);
  });

  /**
   * A property that never geocoded cannot be routed, but it must not vanish.
   * `NO_COORDINATES` on the stop is what turns "this tenancy disappeared" into
   * "this address needs geocoding", which somebody can act on.
   */
  it('blocks a stop with no coordinates rather than dropping it', async () => {
    const ungeocoded: StopRow = { id: 's2', sequence: 2, latitude: null, longitude: null };
    const { service, stopUpdateMany } = build([stop('s1', 1), ungeocoded, stop('s3', 3, 2)]);

    const summary = await service.route('org-1', 'plan-1');

    expect(summary.placed).toBe(2);
    expect(stopUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['s2'] } },
        data: expect.objectContaining({ status: TbpStopStatus.BLOCKED, blockedCode: 'NO_COORDINATES' }),
      }),
    );
  });

  /** A published stop is an inspection and a Jobber visit; routing it again would only disagree with both. */
  it('refuses to route a plan that is no longer a draft', async () => {
    const { service, dayDeleteMany } = build([stop('s1', 1)], { plan: { status: TbpPlanStatus.PUBLISHED } });

    await expect(service.route('org-1', 'plan-1')).rejects.toMatchObject({ code: 'PLAN_NOT_DRAFT' });
    expect(dayDeleteMany).not.toHaveBeenCalled();
  });

  /**
   * Google first, OSRM second, straight-line last — ordered by how much each
   * can honestly claim.
   */
  it('prefers Google, and records that the numbers are traffic-aware', async () => {
    const { service, dayCreate, osrm } = build([stop('s1', 1), stop('s2', 2, 1)], { googleSeconds: fiveMinutes });

    await service.route('org-1', 'plan-1', { holidays: onlyTheFirstWorkingDay() });

    const day = dayCreate.mock.calls[0][0].data;
    expect(day.durationSource).toBe(DriveTimeSource.GOOGLE_TRAFFIC_AWARE);
    expect(day.totalDriveSeconds).toBe(300);
    expect(day.totalDriveMeters).toBe(3000);
    expect(osrm.durations).not.toHaveBeenCalled();
  });

  /**
   * A technician with no home on file starts the day at the first job. So the
   * matrix holds the day's stops and nothing else -- no made-up home or middle
   * -- and the drive counted is between them only.
   */
  it('measures a day between its stops only when no home is on file', async () => {
    const { service, google, dayCreate } = build([stop('s1', 1), stop('s2', 2, 1), stop('s3', 3, 2)], {
      googleSeconds: fiveMinutes,
    });

    await service.route('org-1', 'plan-1', { holidays: onlyTheFirstWorkingDay() });

    expect((google.matrix as jest.Mock).mock.calls[0][0]).toHaveLength(3);
    const day = dayCreate.mock.calls[0][0].data;
    expect(day.totalDriveSeconds).toBe(600);
    expect(day.originKind).toBe(PlanOriginKind.FIRST_STOP);
  });

  it('falls back to OSRM, and says the numbers are free-flow', async () => {
    const { service, dayCreate } = build([stop('s1', 1), stop('s2', 2, 1)], {
      osrmDurations: [
        [0, 200],
        [200, 0],
      ],
    });

    await service.route('org-1', 'plan-1', { holidays: onlyTheFirstWorkingDay() });

    const day = dayCreate.mock.calls[0][0].data;
    expect(day.durationSource).toBe(DriveTimeSource.OSRM_FREE_FLOW);
    expect(day.totalDriveSeconds).toBe(200);
    // OSRM's /table is asked for durations only, so there is no distance to give.
    expect(day.totalDriveMeters).toBeNull();
  });

  /**
   * The important one. With no routing at all we know how far apart the stops
   * are and *not* how long the drive takes — so the distance is real and the
   * duration is null. A made-up duration is worse than an absent one.
   */
  it('reports a distance but no duration when nothing can route', async () => {
    const { service, dayCreate } = build([stop('s1', 1), stop('s2', 2, 1)]);

    const summary = await service.route('org-1', 'plan-1', { holidays: onlyTheFirstWorkingDay() });

    const day = dayCreate.mock.calls[0][0].data;
    expect(day.durationSource).toBe(DriveTimeSource.HAVERSINE);
    expect(day.totalDriveSeconds).toBeNull();
    expect(day.totalDriveMeters).toBeGreaterThan(0);
    expect(summary.durationSource).toBe(DriveTimeSource.HAVERSINE);
  });

  /**
   * Re-routing has to be safe to run more than once, and a coordinator's own
   * choice of day or technician is a decision — not something an automation
   * gets to reverse on its next pass.
   */
  /**
   * A visit a coordinator placed by hand stays on the day and with the
   * technician they chose (the office, 2026-09-16) -- even a day the planner
   * would not use, with somebody off the crew -- and its day is counted there.
   */
  it('keeps a visit a coordinator placed on their day and technician, and counts its day there', async () => {
    const placed: StopRow = {
      ...stop('s1', 1),
      scheduledOn: '2026-10-02',
      assignedTechnicianId: 'tech-2',
      scheduleOverriddenAt: new Date('2026-09-16'),
      technicianOverriddenAt: new Date('2026-09-16'),
    };
    const { service, stopUpdate, dayCreate } = build([placed, stop('s2', 2, 1)], {
      technicians: [
        { technicianId: 'tech-1', isPlannable: true },
        { technicianId: 'tech-2', isPlannable: true, tbpZoneOrder: null },
      ],
    });

    const summary = await service.route('org-1', 'plan-1', { holidays: onlyOn('2026-10-01') });

    expect(summary.unplaced).toEqual([]);
    expect(updateFor(stopUpdate, 's1')).toMatchObject({
      scheduledOn: new Date('2026-10-02T00:00:00.000Z'),
      assignedTechnicianId: 'tech-2',
      positionInDay: 1,
    });
    expect(updateFor(stopUpdate, 's2')).toMatchObject({
      scheduledOn: new Date('2026-10-01T00:00:00.000Z'),
      assignedTechnicianId: 'tech-1',
    });
    const days = dayCreate.mock.calls.map((call) => call[0].data);
    expect(days).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ technicianId: 'tech-2', date: new Date('2026-10-02T00:00:00.000Z'), stopCount: 1 }),
        expect.objectContaining({ technicianId: 'tech-1', date: new Date('2026-10-01T00:00:00.000Z'), stopCount: 1 }),
      ]),
    );
  });

  /** The limit is the office's rule for the planner; a coordinator's own day over it is theirs to see. */
  it('never takes a coordinator’s visit off its day for the drive limit', async () => {
    const byHand = (id: string, sequence: number, offset: number): StopRow => ({
      ...stop(id, sequence, offset),
      scheduledOn: '2026-10-01',
      assignedTechnicianId: 'tech-1',
      scheduleOverriddenAt: new Date('2026-09-16'),
      technicianOverriddenAt: new Date('2026-09-16'),
    });
    const { service, dayCreate } = build([byHand('a', 1, 0), byHand('b', 2, 30)], {
      plan: { maxDriveMinutes: 30 },
      googleSeconds: () => 3600,
    });

    const summary = await service.route('org-1', 'plan-1', { holidays: onlyOn('2026-10-01') });

    expect(summary.unplaced).toEqual([]);
    expect(dayCreate.mock.calls[0][0].data).toMatchObject({ stopCount: 2, totalDriveSeconds: 3600 });
  });

  /** The office (2026-09-16): full days, at least nine visits where the properties allow. */
  it('lays visits due the same fortnight out as one full day, not one a day', async () => {
    const stops = Array.from({ length: 10 }, (_, index) => stop(`s${index + 1}`, index + 1, index * 0.1));
    const { service, dayCreate } = build(stops, { googleSeconds: fiveMinutes });

    const summary = await service.route('org-1', 'plan-1', {
      holidays: onlyOn('2026-10-01', '2026-10-02', '2026-10-06', '2026-10-07', '2026-10-08'),
    });

    expect(summary.placed).toBe(10);
    expect(dayCreate).toHaveBeenCalledTimes(1);
    expect(dayCreate.mock.calls[0][0].data).toMatchObject({ stopCount: 10, totalDriveSeconds: 9 * 300 });
  });

  it('counts a visit at the length a coordinator set, and leaves it when lengths are reset by kind', async () => {
    const longer: StopRow = { ...stop('s1', 1), onSiteMinutes: 90, onSiteMinutesOverriddenAt: new Date('2026-09-16') };
    const { service, dayCreate, stopUpdateMany } = build([longer]);

    await service.route('org-1', 'plan-1', { holidays: onlyOn('2026-10-01') });

    expect(dayCreate.mock.calls[0][0].data.onSiteMinutes).toBe(90);
    expect(stopUpdateMany).toHaveBeenCalledWith({
      where: { planId: 'plan-1', organizationId: 'org-1', inspectionType: InspectionType.OCCUPIED, onSiteMinutesOverriddenAt: null },
      data: { onSiteMinutes: 30 },
    });
  });

  /**
   * Cleared before writing, so a re-route never leaves a day from the previous
   * run beside the new ones -- and a stop this run cannot place does not keep
   * the day the last run gave it, which publish would book.
   */
  it('clears the previous forecast, and every stop’s old day, before writing a new one', async () => {
    const { service, dayDeleteMany, stopUpdateMany } = build([stop('s1', 1)]);

    await service.route('org-1', 'plan-1');

    expect(dayDeleteMany).toHaveBeenCalledWith({ where: { planId: 'plan-1' } });
    expect(stopUpdateMany).toHaveBeenCalledWith({
      where: { planId: 'plan-1', organizationId: 'org-1', status: TbpStopStatus.PLANNED, scheduleOverriddenAt: null },
      data: { scheduledOn: null },
    });
  });

  it('puts back to planning the stops a previous run could not place', async () => {
    const { service, stopUpdateMany } = build([stop('s1', 1)]);

    await service.route('org-1', 'plan-1');

    expect(stopUpdateMany.mock.calls[0][0]).toEqual({
      where: {
        planId: 'plan-1',
        organizationId: 'org-1',
        status: TbpStopStatus.BLOCKED,
        blockedCode: { in: ['NO_COORDINATES', 'NOT_PLACED'] },
      },
      data: { status: TbpStopStatus.PLANNED, blockedCode: null, blockedMessage: null },
    });
  });

  it('places nothing when nobody is qualified, and blocks the stop with the reason', async () => {
    const { service, stopUpdateMany } = build([stop('s1', 1)], { qualified: [] });

    const summary = await service.route('org-1', 'plan-1');

    expect(summary.placed).toBe(0);
    expect(summary.unplaced).toEqual([{ stopId: 's1', reason: 'NO_QUALIFIED_TECHNICIAN' }]);
    expect(stopUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1'] }, planId: 'plan-1' },
      data: expect.objectContaining({ status: TbpStopStatus.BLOCKED, blockedCode: 'NOT_PLACED' }),
    });
  });
});

describe('the office’s limits on a planned day', () => {
  it('keeps the settings it was routed with on the plan', async () => {
    const { service, planUpdate } = build([stop('s1', 1)]);

    const summary = await service.route('org-1', 'plan-1', { hvacVisitMinutes: 60, holidays: ['2026-11-26'] });

    expect(planUpdate.mock.calls[0][0]).toEqual({
      where: { id: 'plan-1' },
      data: {
        occupiedVisitMinutes: 30,
        hvacVisitMinutes: 60,
        maxOnSiteMinutes: 360,
        maxDriveMinutes: 90,
        minStopsPerDay: 9,
        holidays: ['2026-11-26'],
      },
    });
    expect(summary.settings.hvacVisitMinutes).toBe(60);
  });

  it('counts each visit by its own length on the day', async () => {
    const { service, dayCreate } = build(
      [stop('s1', 1), stop('s2', 2, 1, { inspectionType: InspectionType.HVAC })],
      { googleSeconds: fiveMinutes },
    );

    await service.route('org-1', 'plan-1', { holidays: onlyTheFirstWorkingDay() });

    expect(dayCreate.mock.calls[0][0].data).toMatchObject({ onSiteMinutes: 75, hvacStopCount: 1, stopCount: 2 });
  });

  /**
   * Laid out on an estimate, measured on roads. A day the roads say is over
   * ninety minutes gives up the stop that costs it most, to a technician who
   * can take it.
   */
  /** Within the zone's technician's own days: a day that measures over gives a stop to another of them. */
  it('moves a stop off a day that measures over the drive limit', async () => {
    // Two days, one technician on the zone. The estimate lays the four out as
    // one day; Google says s3 is 100 minutes from the rest, so it goes to the
    // other day near its week, which only it needs.
    const outlier = stop('s3', 3, 2);
    const slow = (from: Point, to: Point) =>
      from.latitude === outlier.latitude || to.latitude === outlier.latitude ? 6000 : 300;
    const { service, stopUpdate } = build([stop('s1', 1), stop('s2', 2, 1), outlier, stop('s4', 4, 3)], {
      googleSeconds: slow,
    });

    const summary = await service.route('org-1', 'plan-1', { holidays: onlyOn('2026-10-01', '2026-10-02') });

    expect(summary.repaired).toBe(1);
    expect(summary.unplaced).toEqual([]);
    const dayOf = (id: string) => (updateFor(stopUpdate, id)?.scheduledOn as Date).toISOString().slice(0, 10);
    expect([dayOf('s2'), dayOf('s4')]).toEqual([dayOf('s1'), dayOf('s1')]);
    expect(dayOf('s3')).not.toBe(dayOf('s1'));
  });

  it('blocks a stop no day can take inside the drive limit, rather than keeping an over-limit day', async () => {
    const outlier = stop('s3', 3, 2);
    const slow = (from: Point, to: Point) =>
      from.latitude === outlier.latitude || to.latitude === outlier.latitude ? 6000 : 300;
    const { service, stopUpdateMany, dayCreate } = build([stop('s1', 1), stop('s2', 2, 1), outlier], {
      googleSeconds: slow,
    });

    const summary = await service.route('org-1', 'plan-1', { holidays: onlyTheFirstWorkingDay() });

    expect(summary.unplaced.map((entry) => entry.stopId)).toEqual(['s3']);
    expect(stopUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s3'] }, planId: 'plan-1' },
      data: expect.objectContaining({ status: TbpStopStatus.BLOCKED, blockedCode: 'NOT_PLACED' }),
    });
    expect(dayCreate.mock.calls.every((call) => call[0].data.totalDriveSeconds <= 90 * 60)).toBe(true);
  });

  it('refuses settings nobody meant', async () => {
    const { service } = build([stop('s1', 1)]);

    await expect(service.route('org-1', 'plan-1', { maxDriveMinutes: 900 })).rejects.toMatchObject({
      code: 'INVALID_PLAN_SETTINGS',
    });
    expect(() => routingSettings(PLAN, { holidays: ['next tuesday'] })).toThrow('YYYY-MM-DD');
  });
});

describe('who a planned day goes to', () => {
  /**
   * `isPlannable` is a coordinator saying "not this quarter" — long leave, a
   * supervisor who only covers. Distinct from deactivating the account, which
   * would also take away their handset.
   */
  it('leaves out a technician marked unplannable', async () => {
    const { service, stopUpdate } = build([stop('s1', 1), stop('s2', 2, 1)], {
      technicians: [
        { technicianId: 'tech-away', isPlannable: false },
        { technicianId: 'tech-here', isPlannable: true },
      ],
      qualified: ['tech-away', 'tech-here'],
    });

    await service.route('org-1', 'plan-1');

    const assigned = stopUpdate.mock.calls.map((call) => call[0].data.assignedTechnicianId);
    expect(assigned).not.toContain('tech-away');
    expect(assigned).toContain('tech-here');
  });

  /** Office staff who test the app carry the technician role; a plan books real visits. */
  it('leaves out a technician with no planning profile', async () => {
    const { service, stopUpdate } = build([stop('s1', 1)], {
      technicians: [{ technicianId: 'tech-profiled', isPlannable: true }],
      qualified: ['office-tester', 'tech-profiled'],
    });

    await service.route('org-1', 'plan-1');

    expect(updateFor(stopUpdate, 's1')?.assignedTechnicianId).toBe('tech-profiled');
  });

  it('sends an HVAC visit only to a technician qualified for HVAC', async () => {
    const { service, stopUpdate } = build([stop('s1', 1, 0, { inspectionType: InspectionType.HVAC })], {
      technicians: [
        { technicianId: 'tech-1', isPlannable: true },
        { technicianId: 'tech-hvac', isPlannable: true },
      ],
      qualifiedFor: { HVAC: ['tech-hvac'], OCCUPIED: ['tech-1', 'tech-hvac'] },
    });

    await service.route('org-1', 'plan-1');

    expect(updateFor(stopUpdate, 's1')?.assignedTechnicianId).toBe('tech-hvac');
  });

  /** The office's crew (2026-09-16) takes the visits; a plannable technician off the crew is not sent. */
  it('leaves out a technician who is not on the benefit-package crew', async () => {
    const { service, stopUpdate } = build([stop('s1', 1), stop('s2', 2, 1)], {
      technicians: [
        { technicianId: 'tech-amy', isPlannable: true, tbpZoneOrder: null },
        { technicianId: 'tech-moses', isPlannable: true, tbpZoneOrder: 1 },
      ],
    });

    await service.route('org-1', 'plan-1', { holidays: onlyTheFirstWorkingDay() });

    const assigned = stopUpdate.mock.calls.map((call) => call[0].data.assignedTechnicianId);
    expect(assigned).not.toContain('tech-amy');
    expect(assigned).toContain('tech-moses');
  });

  it('blocks every visit when nobody is on the crew, saying where the crew is set', async () => {
    const { service, stopUpdateMany } = build([stop('s1', 1)], {
      technicians: [{ technicianId: 'tech-1', isPlannable: true, tbpZoneOrder: null }],
    });

    const summary = await service.route('org-1', 'plan-1');

    expect(summary.unplaced).toEqual([{ stopId: 's1', reason: 'NO_QUALIFIED_TECHNICIAN' }]);
    expect(stopUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1'] }, planId: 'plan-1' },
      data: expect.objectContaining({ blockedMessage: expect.stringContaining('planning profiles') }),
    });
  });

  /** Between routes from home that drive the same, the day starts at the property nearer home. */
  it('starts the day at the end nearer the technician’s home', async () => {
    // Laid out north first; the same drive the other way starts beside home.
    const { service, stopUpdate } = build([stop('south', 1, 0), stop('north', 2, 3)], {
      technicians: [{ technicianId: 'tech-1', isPlannable: true, homeLatitude: 29.7, homeLongitude: -95.37 }],
      googleSeconds: fiveMinutes,
    });

    await service.route('org-1', 'plan-1', { holidays: onlyTheFirstWorkingDay() });

    expect(updateFor(stopUpdate, 'south')?.positionInDay).toBe(1);
    expect(updateFor(stopUpdate, 'north')?.positionInDay).toBe(2);
  });
});

/**
 * The office's rules (2026-09-16): Moses, Kevin and Emanuel each have one zone a
 * week and all move one zone on each week; Mondays from the quarter's second
 * week are kept for rescheduled visits.
 */
describe('zones, weeks and Mondays', () => {
  const CREW = [
    { technicianId: 'moses', isPlannable: true, tbpZoneOrder: 1 },
    { technicianId: 'kevin', isPlannable: true, tbpZoneOrder: 2 },
    { technicianId: 'emanuel', isPlannable: true, tbpZoneOrder: 3 },
  ];

  it('gives each zone to its technician for the week, and moves everyone one zone on each week', async () => {
    // Thursday 1 October is in the first week and Friday 16 October in the
    // third: fifteen days apart, so no visit of one can join a day of the other.
    const { service, stopUpdate } = build(
      [
        stop('z1-first-week', 1, 0, { zone: '1' }),
        stop('z2-first-week', 2, 5, { zone: '2' }),
        stop('z1-third-week', 3, 0.1, { zone: '1' }),
        stop('z2-third-week', 4, 5.1, { zone: '2' }),
      ],
      { technicians: CREW },
    );

    await service.route('org-1', 'plan-1', { holidays: onlyOn('2026-10-01', '2026-10-16') });

    const who = (id: string) => [updateFor(stopUpdate, id)?.assignedTechnicianId, updateFor(stopUpdate, id)?.scheduledOn];
    // Two zones and three people: the first week Moses has 1 and Kevin 2; two
    // weeks on, everyone has moved on two -- Kevin to 1, Emanuel to 2.
    expect(who('z1-first-week')).toEqual(['moses', new Date('2026-10-01T00:00:00.000Z')]);
    expect(who('z2-first-week')).toEqual(['kevin', new Date('2026-10-01T00:00:00.000Z')]);
    expect(who('z1-third-week')).toEqual(['kevin', new Date('2026-10-16T00:00:00.000Z')]);
    expect(who('z2-third-week')).toEqual(['emanuel', new Date('2026-10-16T00:00:00.000Z')]);
  });

  it('plans no visit on a Monday from the second week on', async () => {
    const stops = Array.from({ length: 40 }, (_, index) => stop(`s${index + 1}`, index + 1, index * 0.001));
    const { service, dayCreate } = build(stops, { technicians: CREW });

    await service.route('org-1', 'plan-1');

    const dates = dayCreate.mock.calls.map((call) => (call[0].data.date as Date).toISOString().slice(0, 10));
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.filter((date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 1)).toEqual([]);
  });

  it('puts a visit with no zone in the zone nearest it', async () => {
    const { service, stopUpdate } = build(
      [
        stop('south', 1, 0, { zone: '1' }),
        stop('north', 2, 20, { zone: '2' }),
        stop('unzoned', 3, 19.5, { zone: 'Not Set' }),
      ],
      { technicians: CREW },
    );

    await service.route('org-1', 'plan-1', { holidays: onlyOn('2026-10-01') });

    expect(updateFor(stopUpdate, 'unzoned')?.assignedTechnicianId).toBe('kevin');
  });

  it('tells the console who has which zone each week', async () => {
    const homes = CREW.map((row) => ({ ...row, homeLatitude: 29.7, homeLongitude: -95.37 }));
    const { service } = build(
      [stop('a', 1, 0, { zone: '1' }), stop('b', 2, 5, { zone: 'Zone 2' }), stop('c', 3, 180, { zone: '5' })],
      { technicians: homes },
    );

    const rotation = await service.rotation('org-1', 'plan-1');

    expect(rotation.crew.map((member) => member.displayName)).toEqual(['Name of moses', 'Name of kevin', 'Name of emanuel']);
    expect(rotation.zones).toEqual(['1', '2']);
    expect(rotation.outOfReach).toEqual(['5']);
    expect(rotation.weeks[0]).toEqual({
      weekOf: '2026-09-28',
      zones: [
        { zone: '1', technicianId: 'moses' },
        { zone: '2', technicianId: 'kevin' },
      ],
    });
    expect(rotation.weeks[1]).toEqual({
      weekOf: '2026-10-05',
      zones: [
        { zone: '1', technicianId: 'emanuel' },
        { zone: '2', technicianId: 'moses' },
      ],
    });
  });

  /** Zone 5 is some 200 km from the crew's homes: no day can even reach it. */
  it('blocks the visits of a zone nobody on the crew lives within the day’s drive of', async () => {
    const homes = CREW.map((row) => ({ ...row, homeLatitude: 29.7, homeLongitude: -95.37 }));
    const { service, stopUpdateMany, stopUpdate } = build(
      [stop('near', 1, 1, { zone: '1' }), stop('far', 2, 180, { zone: '5' })],
      { technicians: homes },
    );

    const summary = await service.route('org-1', 'plan-1', { holidays: onlyOn('2026-10-01') });

    expect(summary.unplaced).toEqual([{ stopId: 'far', reason: 'ZONE_OUT_OF_REACH' }]);
    expect(updateFor(stopUpdate, 'near')?.assignedTechnicianId).toBe('moses');
    expect(stopUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['far'] }, planId: 'plan-1' },
      data: expect.objectContaining({ blockedMessage: expect.stringContaining('within the day’s drive of this zone') }),
    });
  });
});

/**
 * The office's rules (2026-09-16): a day starts from the technician's home, and
 * the ninety minutes count the drive from home to the first property as well as
 * the drives between the properties. The drive home is not counted.
 */
describe('a day routed from the technician’s home', () => {
  const HOME = { technicianId: 'tech-1', isPlannable: true, homeLatitude: 29.7, homeLongitude: -95.37 };

  /**
   * Drives by place, as Google would give them -- one-way roads and all, so a
   * drive and its return need not take the same time. Places are told apart by
   * latitude: home at 29.70, and the stops `stop()` puts at 29.76 upward.
   */
  const drives = (table: Record<string, number>) => (from: Point, to: Point) => {
    const place = (point: Point) => point.latitude.toFixed(2);
    return table[`${place(from)}>${place(to)}`] ?? 3600;
  };

  it('routes the day from home even when the shortest path between the properties starts at the far end', async () => {
    // P is beside home and R far from it. Between the three, R-Q-P is the
    // shortest path (10 min) and P-Q-R the slower way (20 min), so a day
    // measured from its first job alone started at R -- a 40-minute drive
    // from home to begin a day that could start at P, one minute away.
    const { service, stopUpdate, dayCreate } = build([stop('P', 1, 0), stop('Q', 2, 1), stop('R', 3, 2)], {
      technicians: [HOME],
      googleSeconds: drives({
        '29.70>29.76': 60, '29.70>29.77': 1200, '29.70>29.78': 2400,
        '29.76>29.77': 600, '29.77>29.78': 600, '29.76>29.78': 1200,
        '29.78>29.77': 300, '29.77>29.76': 300, '29.78>29.76': 600,
      }),
    });

    await service.route('org-1', 'plan-1', { holidays: onlyTheFirstWorkingDay() });

    expect(['P', 'Q', 'R'].map((id) => updateFor(stopUpdate, id)?.positionInDay)).toEqual([1, 2, 3]);
    const day = dayCreate.mock.calls[0][0].data;
    expect(day.originKind).toBe(PlanOriginKind.HOME);
    expect(day.homeDriveSeconds).toBe(60);
    // The drive the limit counts: between the properties.
    expect(day.totalDriveSeconds).toBe(1200);
  });

  /** The office (2026-09-16): ninety minutes between the properties; the drive from home is not counted. */
  it('leaves the drive from home out of the day’s drive limit', async () => {
    // X is a minute from home and Y 30 minutes beyond it: 31 in all, and exactly
    // the 30-minute limit between the two properties.
    const { service, stopUpdate, dayCreate } = build([stop('X', 1, 0), stop('Y', 2, 1)], {
      technicians: [HOME],
      plan: { maxDriveMinutes: 30 },
      googleSeconds: drives({
        '29.70>29.76': 60, '29.70>29.77': 1200,
        '29.76>29.77': 1800, '29.77>29.76': 1800,
      }),
    });

    const summary = await service.route('org-1', 'plan-1', { holidays: onlyTheFirstWorkingDay() });

    expect(summary.placed).toBe(2);
    expect(summary.unplaced).toEqual([]);
    expect(updateFor(stopUpdate, 'X')?.positionInDay).toBe(1);
    const day = dayCreate.mock.calls[0][0].data;
    expect(day.totalDriveSeconds).toBe(1800);
    expect(day.homeDriveSeconds).toBe(60);
  });

  it('measures the drive from home to a day of one property', async () => {
    const { service, dayCreate, google } = build([stop('only', 1)], { technicians: [HOME], googleSeconds: fiveMinutes });

    await service.route('org-1', 'plan-1', { holidays: onlyTheFirstWorkingDay() });

    expect((google.matrix as jest.Mock).mock.calls[0][0]).toHaveLength(2);
    const day = dayCreate.mock.calls[0][0].data;
    expect(day.originKind).toBe(PlanOriginKind.HOME);
    expect(day.homeDriveSeconds).toBe(300);
    expect(day.homeDriveMeters).toBe(3000);
    // Nothing to drive between: the drive from home is shown, and not counted.
    expect(day.totalDriveSeconds).toBe(0);
  });

  /** The planning profile stays the one place a technician's address is kept. */
  it('does not copy the home onto the planned day', async () => {
    const { service, dayCreate } = build([stop('a', 1), stop('b', 2, 1)], { technicians: [HOME], googleSeconds: fiveMinutes });

    await service.route('org-1', 'plan-1', { holidays: onlyTheFirstWorkingDay() });

    const day = dayCreate.mock.calls[0][0].data;
    expect(day.originLatitude).toBeNull();
    expect(day.originLongitude).toBeNull();
  });

  it('starts at the first job, as before, for a technician with no home on file', async () => {
    const { service, dayCreate } = build([stop('a', 1), stop('b', 2, 1)], { googleSeconds: fiveMinutes });

    await service.route('org-1', 'plan-1', { holidays: onlyTheFirstWorkingDay() });

    const day = dayCreate.mock.calls[0][0].data;
    expect(day.originKind).toBe(PlanOriginKind.FIRST_STOP);
    expect(day.homeDriveSeconds).toBeNull();
  });
});
