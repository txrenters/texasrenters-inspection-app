import { InspectionType } from '@prisma/client';

import type { PrismaService } from '../src/common/prisma.service';
import type { JobberVisit } from '../src/integrations/jobber/jobber.schemas';
import { QuarterPlannerService, routingSettings } from '../src/planning/quarter-planner.service';
import { JobberSyncWorker, type JobberSyncResult } from '../src/workers/jobber-sync/jobber-sync.worker';

/**
 * A visit the office moved in Jobber moves its quarter plan's stop too.
 *
 * Before this, the sync moved only `Inspection.scheduledAt`. The planner reads a
 * booked visit's day from `TbpQuarterPlanStop.scheduledOn`, so a rebuild that
 * laid the visit back on its old day saw nothing to send, and the plan said the
 * 5th while Jobber said the 9th (found 2026-09-30, before the first visit edit
 * was to be tried through `/route`). People and ids invented.
 */

const OCT_5 = new Date('2026-10-05T00:00:00.000Z');
const OCT_9 = new Date('2026-10-09T00:00:00.000Z');

/** Moved to the 9th in Jobber: an all-day visit, at Texas midnight as the other Jobber specs give one. */
const MOVED_TO_OCT_9 = { id: 'visit-9', startAt: '2026-10-09T05:00:00Z', allDay: true } as unknown as JobberVisit;

const result = (): JobberSyncResult => ({
  correlationId: 'c1',
  visitsSeen: 1,
  imported: 0,
  rescheduled: 0,
  unmatched: 0,
  rejected: 0,
  alreadyComplete: 0,
  notSynced: 0,
  assigned: 0,
  completedFromJobber: 0,
  skipped: 0,
  truncated: false,
});

interface StopState {
  id: string;
  planId: string;
  scheduledOn: Date | null;
  assignedTechnicianId: string | null;
  positionInDay?: number | null;
  scheduleOverriddenAt?: Date | null;
  technicianOverriddenAt?: Date | null;
}

/**
 * The sync against one inspection and, when there is one, its stop.
 *
 * Stateful, so a second pass sees what the first wrote: "the same date twice"
 * is then two real syncs rather than two unrelated fixtures.
 */
function sync({
  inspection: overrides = {},
  stop = null,
}: {
  inspection?: Record<string, unknown>;
  stop?: StopState | null;
} = {}) {
  const inspection: Record<string, unknown> = {
    id: 'inspection-1',
    status: 'SCHEDULED',
    startedAt: null,
    scheduledAt: OCT_5,
    scheduledStartAt: null,
    scheduledEndAt: null,
    jobberVisitTitle: null,
    jobberVisitDetails: null,
    ...overrides,
  };
  const tx = {
    inspection: {
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(inspection, data)),
    },
    tbpQuarterPlanStop: {
      findFirst: jest.fn(async () => (stop ? { ...stop } : null)),
      update: jest.fn(async ({ data }: { data: Partial<StopState> }) => Object.assign(stop!, data)),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    jobberOutboundTask: { findMany: jest.fn().mockResolvedValue([]) },
    inspection: {
      findFirst: jest.fn(async () => ({ ...inspection })),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    jobberVisitImport: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  const worker = new JobberSyncWorker(prisma as never, {} as never, {} as never) as unknown as {
    applyAssignment: jest.Mock;
    completeFromJobber: jest.Mock;
    applyChanges: (organizationId: string, visit: JobberVisit, inspectionId: string, result: JobberSyncResult) => Promise<void>;
  };
  worker.applyAssignment = jest.fn().mockResolvedValue(undefined);
  worker.completeFromJobber = jest.fn().mockResolvedValue(undefined);
  const run = (visit: JobberVisit = MOVED_TO_OCT_9) => worker.applyChanges('org-1', visit, 'inspection-1', result());
  return { run, prisma, tx, inspection, stop };
}

const planStop = (overrides: Partial<StopState> = {}): StopState => ({
  id: 'stop-1',
  planId: 'plan-1',
  scheduledOn: OCT_5,
  assignedTechnicianId: 'tech-1',
  positionInDay: 4,
  scheduleOverriddenAt: null,
  technicianOverriddenAt: null,
  ...overrides,
});

describe('a visit the office moved in Jobber', () => {
  it("moves its plan stop to the inspection's new day", async () => {
    const { run, inspection, stop } = sync({ stop: planStop() });

    await run();

    expect(inspection.scheduledAt).toEqual(OCT_9);
    // The same day the inspection has, as the DATE column stores it: a rebuild
    // compares the two, and they must not disagree.
    expect(stop!.scheduledOn).toEqual(OCT_9);
    expect(stop!.scheduledOn!.getTime()).toBe((inspection.scheduledAt as Date).getTime());
  });

  it("leaves the old day's order and marks the day and technician as a person's", async () => {
    const { run, tx } = sync({ stop: planStop() });

    await run();

    const { data } = tx.tbpQuarterPlanStop.update.mock.calls[0]![0];
    expect(data).toMatchObject({
      positionInDay: null,
      driveSecondsForecast: null,
      scheduleOverriddenAt: expect.any(Date),
      technicianOverriddenAt: expect.any(Date),
    });
  });

  it("looks for the stop only in the inspection's organization", async () => {
    const { run, tx } = sync({ stop: planStop() });

    await run();

    expect(tx.tbpQuarterPlanStop.findFirst.mock.calls[0]).toEqual([
      expect.objectContaining({ where: { organizationId: 'org-1', inspectionId: 'inspection-1' } }),
    ]);
  });

  it('records the move on the reschedule it came with', async () => {
    const { run, tx } = sync({ stop: planStop() });

    await run();

    expect(tx.auditLog.create.mock.calls[0]![0].data).toMatchObject({
      action: 'INSPECTION_RESCHEDULED_FROM_JOBBER',
      metadata: { planStop: { stopId: 'stop-1', planId: 'plan-1', from: '2026-10-05', to: '2026-10-09' } },
    });
  });

  it('writes nothing when a later sync sees the same date again', async () => {
    const { run, prisma, tx } = sync({ stop: planStop() });

    await run();
    await run();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.inspection.update).toHaveBeenCalledTimes(1);
    expect(tx.tbpQuarterPlanStop.update).toHaveBeenCalledTimes(1);
  });

  it('leaves a stop already on the day alone when only the time changed', async () => {
    // Given a time on the day it already had: the inspection takes the window,
    // and the stop, already there, is not written or marked.
    const { run, tx } = sync({ inspection: { scheduledAt: OCT_9 }, stop: planStop({ scheduledOn: OCT_9 }) });

    await run({ id: 'visit-9', startAt: '2026-10-09T14:00:00Z', endAt: '2026-10-09T15:00:00Z' } as unknown as JobberVisit);

    expect(tx.inspection.update).toHaveBeenCalledTimes(1);
    expect(tx.tbpQuarterPlanStop.update).not.toHaveBeenCalled();
  });

  it('reschedules an inspection with no plan stop exactly as before', async () => {
    // A move-in, or any visit the quarter planner never published.
    const { run, inspection, tx } = sync({ stop: null });

    await run();

    expect(inspection.scheduledAt).toEqual(OCT_9);
    expect(tx.tbpQuarterPlanStop.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create.mock.calls[0]![0].data.metadata).not.toHaveProperty('planStop');
  });

  it('follows the inspection, not Jobber: a visit already under way keeps both where they were', async () => {
    const { run, inspection, stop, prisma } = sync({
      inspection: { status: 'IN_PROGRESS', startedAt: new Date('2026-10-05T14:00:00Z') },
      stop: planStop(),
    });

    await run();

    expect(inspection.scheduledAt).toEqual(OCT_5);
    expect(stop!.scheduledOn).toEqual(OCT_5);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

/**
 * Why both marks, from the planner's side.
 *
 * On a rebuild that may move booked visits, a stop is held on its day only when
 * both the day and the technician are marked as a person's. The day's mark
 * alone also keeps it out of `bookedVisitDays`, so a rebuild would lay it on
 * another day and tell neither the inspection nor Jobber. The sync marks both;
 * this pins the rule it relies on.
 */
describe('a rebuild after the office moved a visit in Jobber', () => {
  const SETTINGS = routingSettings(
    {
      occupiedVisitMinutes: 20,
      hvacVisitMinutes: 20,
      maxOnSiteMinutes: 360,
      maxDriveMinutes: 90,
      minStopsPerDay: 9,
      maxStopsPerDay: 10,
      maxLegMinutes: 20,
      holidays: [],
      excludedZones: [],
      startsOn: null,
      technicianIds: [],
      jobberUnassigned: false,
    },
    {},
    { year: 2026, quarter: 4 },
  );

  async function pinsFor(marks: { scheduleOverriddenAt: Date | null; technicianOverriddenAt: Date | null }) {
    const prisma = {
      tbpQuarterPlanStop: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'stop-1',
            sequence: 1,
            zone: '1',
            inspectionId: 'inspection-1',
            inspectionType: InspectionType.OCCUPIED,
            previousTechnicianId: null,
            previousVisitOn: null,
            previousVisitMonth: null,
            scheduledOn: OCT_9,
            assignedTechnicianId: 'tech-1',
            onSiteMinutes: 20,
            onSiteMinutesOverriddenAt: null,
            propertywareBuilding: { latitude: 29.76, longitude: -95.37 },
            // Booked and not yet started: a rebuild may move it unless a person placed it.
            inspection: { status: 'SCHEDULED', finalizedAt: null },
            ...marks,
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    } as unknown as PrismaService;
    const planner = new QuarterPlannerService(prisma, {} as never, {} as never, {} as never, {} as never) as unknown as {
      plannableStops: (
        organizationId: string,
        planId: string,
        settings: typeof SETTINGS,
        movePublishedVisits: boolean,
      ) => Promise<{ pins: Map<string, { date: string; technicianId: string }> }>;
    };
    const { pins } = await planner.plannableStops('org-1', 'plan-1', SETTINGS, true);
    return pins;
  }

  it('holds it on the day Jobber gave it, with its technician', async () => {
    const at = new Date('2026-10-01T15:00:00Z');
    const pins = await pinsFor({ scheduleOverriddenAt: at, technicianOverriddenAt: at });

    expect(pins.get('stop-1')).toEqual({ date: '2026-10-09', technicianId: 'tech-1' });
  });

  it("would not hold it with the day's mark alone", async () => {
    const pins = await pinsFor({ scheduleOverriddenAt: new Date('2026-10-01T15:00:00Z'), technicianOverriddenAt: null });

    expect(pins.has('stop-1')).toBe(false);
  });
});
