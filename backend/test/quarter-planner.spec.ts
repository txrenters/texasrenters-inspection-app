import { DriveTimeSource, TbpStopStatus } from '@prisma/client';
import { workingDaysOfQuarter } from '@texasrenters/shared';

import type { PrismaService } from '../src/common/prisma.service';
import type { GoogleRoutesClient } from '../src/routing/google-routes.client';
import type { OsrmClient } from '../src/routing/osrm.client';
import type { TechnicianSkillsService } from '../src/admin/technician-skills.service';
import { QuarterPlannerService } from '../src/planning/quarter-planner.service';

interface StopRow {
  id: string;
  sequence: number;
  latitude: number | null;
  longitude: number | null;
  scheduleOverriddenAt?: Date | null;
  technicianOverriddenAt?: Date | null;
}

/** Houston-ish coordinates, so distances are realistic rather than degenerate. */
const stop = (id: string, sequence: number, offset = 0): StopRow => ({
  id,
  sequence,
  latitude: 29.76 + offset * 0.01,
  longitude: -95.37,
});

/**
 * Every working day of Q4 2026 except the first, as holidays.
 *
 * The routing tests need two stops on *one* day, and the planner deliberately
 * spreads a quarter across all of its working days — so with sixty-five of them
 * two stops land two months apart and each crew has a single stop, which has no
 * drive between anything. Closing the office for the rest of the quarter is the
 * honest way to say "one working day" without reaching into the planner.
 */
const onlyTheFirstWorkingDay = () =>
  workingDaysOfQuarter({ year: 2026, quarter: 4 }).slice(1);

const build = (
  stops: StopRow[],
  options: {
    technicians?: { technicianId: string; dailyStopCap: number; isPlannable: boolean }[];
    qualified?: string[];
    googleMatrix?: { durations: number[][]; distances: number[][] } | null;
    osrmDurations?: number[][] | null;
  } = {},
) => {
  const technicians = options.technicians ?? [
    { technicianId: 'tech-1', dailyStopCap: 10, isPlannable: true },
  ];
  const qualified = options.qualified ?? technicians.map((t) => t.technicianId);

  const dayCreate = jest.fn().mockResolvedValue({});
  const stopUpdate = jest.fn().mockResolvedValue({});
  const stopUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
  const dayDeleteMany = jest.fn().mockResolvedValue({ count: 0 });

  const client = {
    tbpQuarterPlan: {
      findFirstOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 'plan-1', quarterYear: 2026, quarterNumber: 4 }),
    },
    tbpQuarterPlanStop: {
      findMany: jest.fn().mockResolvedValue(
        stops.map((row) => ({
          id: row.id,
          sequence: row.sequence,
          propertywareBuilding:
            row.latitude === null ? null : { latitude: row.latitude, longitude: row.longitude },
        })),
      ),
      updateMany: stopUpdateMany,
      update: stopUpdate,
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          stops.find((row) => row.id === where.id) ?? {
            scheduleOverriddenAt: null,
            technicianOverriddenAt: null,
          },
        ),
      ),
    },
    technicianPlanningProfile: { findMany: jest.fn().mockResolvedValue(technicians) },
    tbpQuarterPlanDay: { deleteMany: dayDeleteMany, create: dayCreate },
  };

  const prisma = {
    ...client,
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  } as unknown as PrismaService;

  const skills = {
    qualificationCalendar: jest.fn((_org: string, _type: unknown, dates: Date[]) =>
      Promise.resolve(
        new Map(
          dates.map((date) => [
            date.toISOString().slice(0, 10),
            qualified.map((technicianId) => ({
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

  const google = {
    matrix: jest.fn().mockResolvedValue(options.googleMatrix ?? null),
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
    google,
    osrm,
  };
};

describe('routing a draft quarter', () => {
  it('gives every stop a day, a technician and a position', async () => {
    const { service, stopUpdate } = build([stop('s1', 1), stop('s2', 2, 1), stop('s3', 3, 2)]);

    const summary = await service.route('org-1', 'plan-1');

    expect(summary.placed).toBe(3);
    expect(summary.unplaced).toEqual([]);
    const positions = stopUpdate.mock.calls.map((call) => call[0].data.positionInDay);
    expect(positions.filter(Boolean)).toHaveLength(3);
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
        data: expect.objectContaining({
          status: TbpStopStatus.BLOCKED,
          blockedCode: 'NO_COORDINATES',
        }),
      }),
    );
  });

  /**
   * Google first, OSRM second, straight-line last — ordered by how much each
   * can honestly claim.
   */
  it('prefers Google, and records that the numbers are traffic-aware', async () => {
    const { service, dayCreate, osrm } = build([stop('s1', 1), stop('s2', 2, 1)], {
      googleMatrix: {
        durations: [
          [0, 300, 600],
          [300, 0, 200],
          [600, 200, 0],
        ],
        distances: [
          [0, 5000, 9000],
          [5000, 0, 3000],
          [9000, 3000, 0],
        ],
      },
    });

    await service.route('org-1', 'plan-1', onlyTheFirstWorkingDay());

    const day = dayCreate.mock.calls[0][0].data;
    expect(day.durationSource).toBe(DriveTimeSource.GOOGLE_TRAFFIC_AWARE);
    expect(day.totalDriveSeconds).toBeGreaterThan(0);
    expect(day.totalDriveMeters).toBeGreaterThan(0);
    expect(osrm.durations).not.toHaveBeenCalled();
  });

  it('falls back to OSRM, and says the numbers are free-flow', async () => {
    const { service, dayCreate } = build([stop('s1', 1), stop('s2', 2, 1)], {
      osrmDurations: [
        [0, 300, 600],
        [300, 0, 200],
        [600, 200, 0],
      ],
    });

    await service.route('org-1', 'plan-1', onlyTheFirstWorkingDay());

    const day = dayCreate.mock.calls[0][0].data;
    expect(day.durationSource).toBe(DriveTimeSource.OSRM_FREE_FLOW);
    expect(day.totalDriveSeconds).toBeGreaterThan(0);
    // OSRM's /table is asked for durations only, so there is no distance to give.
    expect(day.totalDriveMeters).toBeNull();
  });

  /**
   * The important one. With no routing at all we know how far apart the stops
   * are and *not* how long the drive takes — so the distance is real and the
   * duration is null. A made-up duration is worse than an absent one: a plan
   * that says "five hours" when it means "we did not measure" is how somebody
   * ends up late.
   */
  it('reports a distance but no duration when nothing can route', async () => {
    const { service, dayCreate } = build([stop('s1', 1), stop('s2', 2, 1)]);

    const summary = await service.route('org-1', 'plan-1', onlyTheFirstWorkingDay());

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

    const pinnedUpdate = stopUpdate.mock.calls.find((call) => call[0].where.id === 's1')![0].data;
    expect(pinnedUpdate).not.toHaveProperty('scheduledOn');
    expect(pinnedUpdate).not.toHaveProperty('assignedTechnicianId');
    // Its place in the route is still recomputed — that is not a decision
    // anybody made, it is a consequence of the day it was pinned to.
    expect(pinnedUpdate.positionInDay).toBe(1);

    const freeUpdate = stopUpdate.mock.calls.find((call) => call[0].where.id === 's2')![0].data;
    expect(freeUpdate).toHaveProperty('scheduledOn');
    expect(freeUpdate).toHaveProperty('assignedTechnicianId');
  });

  /**
   * Cleared before writing, so a re-route never leaves a day from the previous
   * run beside the new ones and doubles the forecast.
   */
  it('clears the previous forecast before writing a new one', async () => {
    const { service, dayDeleteMany } = build([stop('s1', 1)]);

    await service.route('org-1', 'plan-1');

    expect(dayDeleteMany).toHaveBeenCalledWith({ where: { planId: 'plan-1' } });
  });

  it('reports a capacity shortfall rather than silently truncating', async () => {
    // One technician, one stop a day, against a quarter of ~65 working days.
    const many = Array.from({ length: 200 }, (_, index) => stop(`s${index}`, index + 1, index % 5));
    const { service } = build(many, {
      technicians: [{ technicianId: 'tech-1', dailyStopCap: 1, isPlannable: true }],
    });

    const summary = await service.route('org-1', 'plan-1');

    expect(summary.capacity.stops).toBe(200);
    expect(summary.capacity.slots).toBeLessThan(200);
    expect(summary.unplaced.length).toBe(200 - summary.placed);
    expect(summary.unplaced.every((entry) => entry.reason === 'NO_CAPACITY')).toBe(true);
  });

  /**
   * `isPlannable` is a coordinator saying "not this quarter" — long leave, a
   * supervisor who only covers. Distinct from deactivating the account, which
   * would also take away their handset.
   */
  it('leaves out a technician marked unplannable', async () => {
    const { service, stopUpdate } = build([stop('s1', 1), stop('s2', 2, 1)], {
      technicians: [
        { technicianId: 'tech-away', dailyStopCap: 10, isPlannable: false },
        { technicianId: 'tech-here', dailyStopCap: 10, isPlannable: true },
      ],
      qualified: ['tech-away', 'tech-here'],
    });

    await service.route('org-1', 'plan-1');

    const assigned = stopUpdate.mock.calls.map((call) => call[0].data.assignedTechnicianId);
    expect(assigned).not.toContain('tech-away');
    expect(assigned).toContain('tech-here');
  });

  it('places nothing when nobody is qualified, and says so', async () => {
    const { service } = build([stop('s1', 1)], { qualified: [] });

    const summary = await service.route('org-1', 'plan-1');

    expect(summary.placed).toBe(0);
    expect(summary.unplaced).toEqual([{ stopId: 's1', reason: 'NO_QUALIFIED_TECHNICIAN' }]);
  });
});
