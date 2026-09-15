import { DriveTimeSource, InspectionType, PlanOriginKind, TbpPlanStatus, TbpStopStatus } from '@prisma/client';
import { workingDaysOfQuarter } from '@texasrenters/shared';

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
  scheduleOverriddenAt?: Date | null;
  technicianOverriddenAt?: Date | null;
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
  holidays: [] as string[],
};

const build = (
  stops: StopRow[],
  options: {
    plan?: Partial<typeof PLAN>;
    technicians?: { technicianId: string; isPlannable: boolean; homeLatitude?: number | null; homeLongitude?: number | null }[];
    qualified?: string[];
    qualifiedFor?: Partial<Record<InspectionType, string[]>>;
    /** Seconds between two points, as Google would say. Null: Google is not configured. */
    googleSeconds?: ((from: Point, to: Point) => number) | null;
    osrmDurations?: number[][] | null;
  } = {},
) => {
  const technicians = options.technicians ?? [{ technicianId: 'tech-1', isPlannable: true }];
  const qualified = options.qualified ?? technicians.map((row) => row.technicianId);

  const dayCreate = jest.fn().mockResolvedValue({});
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
          inspectionType: row.inspectionType ?? InspectionType.OCCUPIED,
          previousTechnicianId: row.previousTechnicianId ?? null,
          scheduleOverriddenAt: row.scheduleOverriddenAt ?? null,
          technicianOverriddenAt: row.technicianOverriddenAt ?? null,
          propertywareBuilding:
            row.latitude === null ? null : { latitude: row.latitude, longitude: row.longitude },
        })),
      ),
      updateMany: stopUpdateMany,
      update: stopUpdate,
      count: jest.fn().mockResolvedValue(0),
    },
    technicianPlanningProfile: {
      findMany: jest.fn().mockResolvedValue(
        technicians.map((row) => ({ homeLatitude: null, homeLongitude: null, ...row })),
      ),
    },
    tbpQuarterPlanDay: { deleteMany: dayDeleteMany, create: dayCreate },
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
    stopUpdate,
    stopUpdateMany,
    dayDeleteMany,
    planUpdate,
    google,
    osrm,
    skills,
  };
};

const updateFor = (stopUpdate: jest.Mock, id: string) =>
  stopUpdate.mock.calls.find((call) => call[0].where.id === id)?.[0].data as Record<string, unknown> | undefined;

/** Five minutes between any two stops. */
const fiveMinutes = () => 300;

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
   * The office's rule: the day starts at the first job. So the matrix holds the
   * day's stops and nothing else -- no home, and no made-up middle -- and the
   * drive counted is between them only.
   */
  it('measures a day between its stops only, from the first job', async () => {
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
  it('leaves a coordinator’s chosen day and technician alone', async () => {
    const pinned: StopRow = {
      ...stop('s1', 1),
      scheduleOverriddenAt: new Date('2026-09-20'),
      technicianOverriddenAt: new Date('2026-09-20'),
    };
    const { service, stopUpdate } = build([pinned, stop('s2', 2, 1)]);

    await service.route('org-1', 'plan-1');

    const pinnedUpdate = updateFor(stopUpdate, 's1')!;
    expect(pinnedUpdate).not.toHaveProperty('scheduledOn');
    expect(pinnedUpdate).not.toHaveProperty('assignedTechnicianId');
    expect(pinnedUpdate.positionInDay).toBe(1);

    const freeUpdate = updateFor(stopUpdate, 's2')!;
    expect(freeUpdate).toHaveProperty('scheduledOn');
    expect(freeUpdate).toHaveProperty('assignedTechnicianId');
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
  it('moves a stop off a day that measures over the drive limit', async () => {
    const outlier = stop('s3', 3, 2);
    const slow = (from: Point, to: Point) =>
      from.latitude === outlier.latitude || to.latitude === outlier.latitude ? 6000 : 300;
    const { service, stopUpdate } = build([stop('s1', 1), stop('s2', 2, 1), outlier], {
      technicians: [
        { technicianId: 'tech-1', isPlannable: true },
        { technicianId: 'tech-2', isPlannable: true },
      ],
      googleSeconds: slow,
    });

    const summary = await service.route('org-1', 'plan-1', { holidays: onlyTheFirstWorkingDay() });

    expect(summary.repaired).toBe(1);
    expect(summary.unplaced).toEqual([]);
    expect(updateFor(stopUpdate, 's1')?.assignedTechnicianId).toBe('tech-1');
    expect(updateFor(stopUpdate, 's3')?.assignedTechnicianId).toBe('tech-2');
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

  it('sends the technician who took the tenancies last quarter', async () => {
    const { service, stopUpdate } = build(
      [stop('s1', 1, 0, { previousTechnicianId: 'tech-2' }), stop('s2', 2, 1, { previousTechnicianId: 'tech-2' })],
      {
        technicians: [
          { technicianId: 'tech-1', isPlannable: true },
          { technicianId: 'tech-2', isPlannable: true },
        ],
      },
    );

    await service.route('org-1', 'plan-1', { holidays: onlyTheFirstWorkingDay() });

    expect(updateFor(stopUpdate, 's1')?.assignedTechnicianId).toBe('tech-2');
    expect(updateFor(stopUpdate, 's2')?.assignedTechnicianId).toBe('tech-2');
  });

  /** The drive from home is not counted, but it is driven: between equal orders, start near home. */
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
