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
  maxStopsPerDay: 12,
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
      handlesMoveOuts?: boolean;
    }[];
    /** Move-outs booked in the quarter, as the inspections query answers. */
    moveOuts?: { id: string; scheduledAt: string; latitude: number | null }[];
    /** A day's move-outs recorded by an earlier layout, for measuring it again. */
    anchorRows?: { inspectionId: string; onSiteMinutes: number; latitude: number }[];
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
  const anchorCreate = jest.fn().mockResolvedValue({});
  const anchorUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const anchorDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const inspectionFindMany = jest.fn().mockResolvedValue(
    (options.moveOuts ?? []).map((row) => ({
      id: row.id,
      scheduledAt: new Date(`${row.scheduledAt}T00:00:00.000Z`),
      propertywareBuilding: row.latitude === null ? null : { latitude: row.latitude, longitude: -95.37 },
    })),
  );

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
      findFirst: jest.fn(({ where }: { where: { technicianId?: string; handlesMoveOuts?: boolean } }) =>
        Promise.resolve(
          where.handlesMoveOuts
            ? (profiles
                .filter((row) => row.isPlannable && row.handlesMoveOuts)
                .sort((left, right) => (left.tbpZoneOrder ?? 99) - (right.tbpZoneOrder ?? 99))[0] ?? null)
            : (profiles.find((row) => row.technicianId === where.technicianId) ?? null),
        ),
      ),
    },
    tbpQuarterPlanDay: { deleteMany: dayDeleteMany, create: dayCreate, upsert: dayUpsert },
    tbpQuarterPlanAnchor: {
      deleteMany: anchorDeleteMany,
      create: anchorCreate,
      updateMany: anchorUpdateMany,
      findMany: jest.fn().mockResolvedValue(
        (options.anchorRows ?? []).map((row) => ({
          inspectionId: row.inspectionId,
          onSiteMinutes: row.onSiteMinutes,
          inspection: { propertywareBuilding: { latitude: row.latitude, longitude: -95.37 } },
        })),
      ),
    },
    inspection: { findMany: inspectionFindMany },
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
    anchorCreate,
    anchorUpdateMany,
    anchorDeleteMany,
    inspectionFindMany,
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

  it('measures a day with the move-out it is built around, and keeps it with no visit left', async () => {
    const { service, stopFindMany, dayUpsert, dayDeleteMany, anchorUpdateMany } = build([], {
      googleSeconds: fiveMinutes,
      anchorRows: [{ inspectionId: 'move-out-1', onSiteMinutes: 60, latitude: 29.8 }],
    });
    stopFindMany.mockResolvedValueOnce([onDay('s1', 1, 0)]).mockResolvedValueOnce([]);

    await service.measureDays('org-1', 'plan-1', [
      { date: '2026-10-02', technicianId: 'tech-1' },
      { date: '2026-10-05', technicianId: 'tech-1' },
    ]);

    expect(dayUpsert.mock.calls[0][0].create).toMatchObject({ stopCount: 1, onSiteMinutes: 105, totalDriveSeconds: 300 });
    expect(anchorUpdateMany).toHaveBeenCalledWith({
      where: { planId: 'plan-1', inspectionId: 'move-out-1' },
      data: expect.objectContaining({ positionInDay: expect.any(Number) }),
    });
    // The second day has no visit left, but its move-out is still there.
    expect(dayDeleteMany).not.toHaveBeenCalled();
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
    for (const id of ['s1', 's2', 's3'])
      expect(updateFor(stopUpdate, id)).toMatchObject({ assignedTechnicianId: expect.any(String), scheduledOn: expect.any(Date) });
    // Three visits are one day, never three of one: nine a day comes first (2026-09-17).
    expect(['s1', 's2', 's3'].map((id) => updateFor(stopUpdate, id)?.positionInDay).sort()).toEqual([1, 2, 3]);
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

  /** A coordinator's own day is theirs to see, however long its drive. */
  it('keeps a coordinator’s own day whole, however long its drive', async () => {
    const byHand = (id: string, sequence: number, offset: number): StopRow => ({
      ...stop(id, sequence, offset),
      scheduledOn: '2026-10-01',
      assignedTechnicianId: 'tech-1',
      scheduleOverriddenAt: new Date('2026-09-16'),
      technicianOverriddenAt: new Date('2026-09-16'),
    });
    const { service, dayCreate } = build([byHand('a', 1, 0), byHand('b', 2, 30)], {
      googleSeconds: () => 3600,
    });

    const summary = await service.route('org-1', 'plan-1', { holidays: onlyOn('2026-10-01') });

    expect(summary.unplaced).toEqual([]);
    expect(dayCreate.mock.calls[0][0].data).toMatchObject({ stopCount: 2, totalDriveSeconds: 3600 });
  });

  /** The office (2026-09-17): nine to twelve visits every day. */
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

/**
 * The office (2026-09-17): move-outs are Moses's, and "we should be doing TBPs
 * around those". On a day he has one, his visits are the ones nearest it.
 */
describe('days built around move-outs', () => {
  const CREW = [
    { technicianId: 'moses', isPlannable: true, tbpZoneOrder: 1, handlesMoveOuts: true },
    { technicianId: 'kevin', isPlannable: true, tbpZoneOrder: 2 },
  ];
  /** Moses's zone near the office, and Kevin's some twenty kilometres north, where the move-out is. */
  const stops = [
    ...Array.from({ length: 9 }, (_, index) => stop(`near-${index + 1}`, index + 1, index * 0.01, { zone: '1' })),
    ...Array.from({ length: 12 }, (_, index) => stop(`north-${index + 1}`, 10 + index, 20 + index * 0.01, { zone: '2' })),
  ];

  it('gives the move-out’s day to whoever handles move-outs, with the visits nearest it', async () => {
    const { service, stopUpdate, anchorCreate, dayCreate, inspectionFindMany } = build(stops, {
      technicians: CREW,
      moveOuts: [{ id: 'move-out-1', scheduledAt: '2026-10-01', latitude: 29.96 }],
    });

    const summary = await service.route('org-1', 'plan-1', { holidays: onlyOn('2026-10-01', '2026-10-02') });

    expect(inspectionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ inspectionType: InspectionType.MOVE_OUT, status: { not: 'CANCELLED' } }),
      }),
    );
    expect(summary.anchored).toBe(1);
    expect(anchorCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inspectionId: 'move-out-1',
        technicianId: 'moses',
        date: new Date('2026-10-01T00:00:00.000Z'),
        onSiteMinutes: 60,
        positionInDay: expect.any(Number),
      }),
    });
    // Kevin's zone that day, because that is where the move-out is.
    const mosesOnTheFirst = stops.filter((row) => {
      const update = updateFor(stopUpdate, row.id);
      return update?.assignedTechnicianId === 'moses' && (update.scheduledOn as Date).toISOString().startsWith('2026-10-01');
    });
    expect(mosesOnTheFirst.length).toBeGreaterThanOrEqual(9);
    expect(mosesOnTheFirst.every((row) => row.id.startsWith('north'))).toBe(true);
    const day = dayCreate.mock.calls.map((call) => call[0].data).find((data) => data.technicianId === 'moses' && data.date.toISOString().startsWith('2026-10-01'));
    // The visits, and the move-out's hour on top of their time on site.
    expect(day).toMatchObject({ stopCount: mosesOnTheFirst.length, onSiteMinutes: mosesOnTheFirst.length * 30 + 60 });
  });

  it('anchors nothing when nobody is marked as handling move-outs', async () => {
    const { service, anchorCreate, inspectionFindMany } = build(stops, {
      technicians: CREW.map((row) => ({ ...row, handlesMoveOuts: false })),
      moveOuts: [{ id: 'move-out-1', scheduledAt: '2026-10-01', latitude: 29.96 }],
    });

    const summary = await service.route('org-1', 'plan-1', { holidays: onlyOn('2026-10-01', '2026-10-02') });

    expect(inspectionFindMany).not.toHaveBeenCalled();
    expect(anchorCreate).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ anchored: 0, anchorsSkipped: [] });
  });

  it('says which move-outs no day could be built around, and why', async () => {
    const { service, anchorCreate } = build(stops, {
      technicians: CREW,
      moveOuts: [
        { id: 'no-location', scheduledAt: '2026-10-01', latitude: null },
        // A Monday from the second week, kept for rescheduled visits.
        { id: 'kept-free-monday', scheduledAt: '2026-10-05', latitude: 29.96 },
      ],
    });

    const summary = await service.route('org-1', 'plan-1', { holidays: onlyOn('2026-10-01', '2026-10-02') });

    expect(anchorCreate).not.toHaveBeenCalled();
    expect(summary.anchorsSkipped).toEqual([
      { inspectionId: 'no-location', reason: 'NO_LOCATION' },
      { inspectionId: 'kept-free-monday', reason: 'NOT_A_PLANNED_DAY' },
    ]);
  });

  it('clears the move-outs of the last layout before recording this one’s', async () => {
    const { service, anchorDeleteMany } = build(stops, { technicians: CREW });

    await service.route('org-1', 'plan-1', { holidays: onlyOn('2026-10-01', '2026-10-02') });

    expect(anchorDeleteMany).toHaveBeenCalledWith({ where: { planId: 'plan-1' } });
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
        maxStopsPerDay: 12,
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
   * The office (2026-09-17): the drive between a day's properties is kept short,
   * never capped. Google says s3 is a hundred minutes from the rest, and the day
   * keeps it rather than leave it for a day of its own or for a person.
   */
  it('keeps a day whole however long Google measures its drive', async () => {
    const outlier = stop('s3', 3, 2);
    const slow = (from: Point, to: Point) =>
      from.latitude === outlier.latitude || to.latitude === outlier.latitude ? 6000 : 300;
    const { service, stopUpdate, stopUpdateMany, dayCreate } = build([stop('s1', 1), stop('s2', 2, 1), outlier, stop('s4', 4, 3)], {
      googleSeconds: slow,
    });

    const summary = await service.route('org-1', 'plan-1', { holidays: onlyOn('2026-10-01', '2026-10-02') });

    expect(summary.unplaced).toEqual([]);
    const dayOf = (id: string) => (updateFor(stopUpdate, id)?.scheduledOn as Date).toISOString().slice(0, 10);
    expect(['s2', 's3', 's4'].map(dayOf)).toEqual([dayOf('s1'), dayOf('s1'), dayOf('s1')]);
    expect(dayCreate).toHaveBeenCalledTimes(1);
    expect(dayCreate.mock.calls[0][0].data.totalDriveSeconds).toBeGreaterThan(90 * 60);
    expect(stopUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ blockedCode: 'NOT_PLACED' }) }),
    );
  });

  it('refuses settings nobody meant', async () => {
    const { service } = build([stop('s1', 1)]);

    await expect(service.route('org-1', 'plan-1', { maxDriveMinutes: 900 })).rejects.toMatchObject({
      code: 'INVALID_PLAN_SETTINGS',
    });
    expect(() => routingSettings(PLAN, { holidays: ['next tuesday'] })).toThrow('YYYY-MM-DD');
    expect(() => routingSettings(PLAN, { minStopsPerDay: 13 })).toThrow('minStopsPerDay must not be more than maxStopsPerDay');
    expect(() => routingSettings(PLAN, { maxStopsPerDay: 25 })).toThrow('maxStopsPerDay must be a whole number from 1 to 24');
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

  it('starts each crew member in their zone of the week, and moves everyone one zone on each week', async () => {
    // Thursday 1 October is in the first week and Tuesday 6 October in the
    // second. Twenty-four visits a zone are two days of twelve, so each zone
    // has a day in both weeks.
    const zone = (name: string, offset: number) =>
      Array.from({ length: 24 }, (_, index) => stop(`z${name}-${index + 1}`, 0, offset + index * 0.01, { zone: name }));
    const stops = [...zone('1', 0), ...zone('2', 5)].map((row, index) => ({ ...row, sequence: index + 1 }));
    const { service, stopUpdate } = build(stops, { technicians: CREW.slice(0, 2) });

    await service.route('org-1', 'plan-1', { holidays: onlyOn('2026-10-01', '2026-10-06') });

    // Two zones and two people: the first week Moses has 1 and Kevin 2, and the
    // week after the other way round.
    const owners = stops.map((row) => {
      const update = updateFor(stopUpdate, row.id);
      return `zone ${row.zone} on ${(update?.scheduledOn as Date).toISOString().slice(0, 10)}: ${String(update?.assignedTechnicianId)}`;
    });
    expect([...new Set(owners)].sort()).toEqual([
      'zone 1 on 2026-10-01: moses',
      'zone 1 on 2026-10-06: kevin',
      'zone 2 on 2026-10-01: kevin',
      'zone 2 on 2026-10-06: moses',
    ]);
  });

  /** The office (2026-09-18): "all 3 should have schedules per day". */
  it('gives the whole crew a day on each planned day, not only whoever has a zone that week', async () => {
    // One zone and three people: two of them have no zone of their own.
    const stops = Array.from({ length: 36 }, (_, index) => stop(`s${index + 1}`, index + 1, index * 0.01));
    const { service, dayCreate } = build(stops, { technicians: CREW });

    await service.route('org-1', 'plan-1', { holidays: onlyOn('2026-10-01', '2026-10-02') });

    const firstDay = dayCreate.mock.calls
      .map((call) => call[0].data)
      .filter((data) => (data.date as Date).toISOString().startsWith('2026-10-01'));
    expect(firstDay.map((data) => data.technicianId).sort()).toEqual(['emanuel', 'kevin', 'moses']);
    expect(firstDay.map((data) => data.stopCount)).toEqual([12, 12, 12]);
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

  /** Zone 5 is some 200 km from the crew's homes (2026-09-18): "a 3-day trip for one person". */
  it('lays a zone too far for a day’s drive out as a trip for the crew member living nearest it', async () => {
    const homes = [
      { ...CREW[0]!, homeLatitude: 29.7, homeLongitude: -95.37 },
      { ...CREW[1]!, homeLatitude: 30.2, homeLongitude: -95.37 },
      { ...CREW[2]!, homeLatitude: 29.7, homeLongitude: -95.37 },
    ];
    // Fourteen visits: two days of the trip.
    const far = Array.from({ length: 14 }, (_, index) => stop(`far-${index + 1}`, 10 + index, 180 + index * 0.01, { zone: '5' }));
    const { service, stopUpdate, dayCreate } = build([stop('near', 1, 1, { zone: '1' }), ...far], {
      technicians: homes,
      googleSeconds: fiveMinutes,
    });

    const summary = await service.route('org-1', 'plan-1', { holidays: onlyOn('2026-10-01', '2026-10-02') });

    expect(summary.unplaced).toEqual([]);
    // Kevin lives nearest, and goes on the two days in a row.
    const trip = far.map((row) => {
      const update = updateFor(stopUpdate, row.id);
      return `${(update?.scheduledOn as Date).toISOString().slice(0, 10)} ${String(update?.assignedTechnicianId)}`;
    });
    expect([...new Set(trip)].sort()).toEqual(['2026-10-01 kevin', '2026-10-02 kevin']);
    // Driven down from home the first day; the second starts where the trip is.
    const kevinsDays = dayCreate.mock.calls
      .map((call) => call[0].data)
      .filter((data) => data.technicianId === 'kevin')
      .sort((left, right) => (left.date as Date).getTime() - (right.date as Date).getTime());
    expect(kevinsDays.map((data) => data.originKind)).toEqual([PlanOriginKind.HOME, PlanOriginKind.FIRST_STOP]);
    expect(updateFor(stopUpdate, 'near')?.assignedTechnicianId).toBe('moses');
  });
});

/**
 * The office's rules (2026-09-17): a day starts from the technician's home, in
 * the order that drives least in all. The drive between the properties is shown
 * apart from the drive from home, and neither is capped.
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
    // Between the properties, shown apart from the drive from home.
    expect(day.totalDriveSeconds).toBe(1200);
  });

  it('shows the drive between the properties apart from the drive from home', async () => {
    // X is a minute from home and Y 30 minutes beyond it: 31 in all, 30 of them
    // between the two properties.
    const { service, stopUpdate, dayCreate } = build([stop('X', 1, 0), stop('Y', 2, 1)], {
      technicians: [HOME],
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

  /**
   * 2026-09-16: Google answered no drive from home for a full day, the route
   * from home came back empty, and the Rebuild failed with a 500. A day Google
   * cannot fully measure is still laid out, routed between its properties.
   */
  it('lays a full day out even when Google answers no drive from home', async () => {
    const stops = Array.from({ length: 9 }, (_, index) => stop(`s${index + 1}`, index + 1, index * 0.1));
    const { service, dayCreate, stopUpdate } = build(stops, {
      technicians: [HOME],
      googleSeconds: (from) => (from.latitude === 29.7 ? Number.POSITIVE_INFINITY : 300),
    });

    const summary = await service.route('org-1', 'plan-1', { holidays: onlyTheFirstWorkingDay() });

    expect(summary.placed).toBe(9);
    const day = dayCreate.mock.calls[0][0].data;
    expect(day).toMatchObject({ stopCount: 9, totalDriveSeconds: 8 * 300, homeDriveSeconds: null });
    const positions = stops.map((row) => updateFor(stopUpdate, row.id)?.positionInDay).sort((a, b) => Number(a) - Number(b));
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
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
