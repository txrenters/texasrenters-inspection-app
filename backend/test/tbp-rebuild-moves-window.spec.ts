import { JobberOutboundKind } from '@prisma/client';

import type { PrismaService } from '../src/common/prisma.service';
import { businessClockTime, businessDate } from '../src/common/business-day';
import { QuarterPlannerService } from '../src/planning/quarter-planner.service';

/**
 * A rebuild that moves a timed visit moves its clock time with it.
 *
 * The push to Jobber sends a visit with a window by that window, not by its
 * day. The rebuild used to write only the day, so a visit the office had given
 * a clock time in Jobber went back to Jobber on the day it already had, and the
 * next sync saw Jobber and the inspection disagree and moved the inspection
 * back: the rebuild's move was lost without a word. The console's own
 * reschedule already moves the window (`admin-jobber-visit-edits.spec.ts`);
 * this is the same rule for the rebuild.
 *
 * TBP visits are published whole-day, so only a visit somebody timed in Jobber
 * is exposed, and a whole-day visit must stay whole-day.
 */

const INSPECTION = 'inspection-1';
const STOP = 'stop-1';

function build(
  window: { scheduledStartAt: Date | null; scheduledEndAt: Date | null },
  move: { from: string; to: string },
) {
  const tx = {
    inspection: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(window),
      // What `requestVisitPush` reads to decide the visit reached Jobber.
      findFirst: jest.fn().mockResolvedValue({ jobberVisitId: 'visit-9', jobberJobId: 'job-9' }),
    },
    inspectionAssignment: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({}),
    },
    jobberOutboundTask: { upsert: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    tbpQuarterPlan: { findUnique: jest.fn().mockResolvedValue({ jobberUnassigned: false }) },
    tbpQuarterPlanStop: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: STOP,
          scheduledOn: new Date(`${move.to}T00:00:00.000Z`),
          // The same technician, so only the day is in play.
          assignedTechnicianId: 'tech-1',
        },
      ]),
    },
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  } as unknown as PrismaService;

  const service = new QuarterPlannerService(prisma, {} as never, {} as never, {} as never, {} as never);
  const before = new Map([[STOP, { inspectionId: INSPECTION, date: move.from, technicianId: 'tech-1' }]]);
  const rebook = (
    service as unknown as {
      rebookMovedVisits: (
        organizationId: string,
        planId: string,
        was: typeof before,
        actorId: string | null,
      ) => Promise<number>;
    }
  ).rebookMovedVisits.bind(service);
  return { rebook: () => rebook('org-1', 'plan-1', before, 'user-1'), tx };
}

/** What the rebuild wrote onto the inspection. */
const written = (tx: ReturnType<typeof build>['tx']) =>
  tx.inspection.update.mock.calls[0][0].data as {
    scheduledAt: Date;
    scheduledStartAt?: Date;
    scheduledEndAt?: Date;
  };

/**
 * Console edits reach Jobber. A rebuild queues its moves only then, as the
 * console does: queued with the switch off they were never sent, and held
 * Jobber's own later moves back for good (2026-10-01).
 */
const pushesOn = () => {
  const previous = { ...process.env };
  beforeEach(() => {
    process.env.JOBBER_PUSH_EDITS_ENABLED = 'true';
  });
  afterEach(() => {
    process.env = { ...previous };
  });
};

describe('a rebuild moving a timed visit', () => {
  pushesOn();

  it('moves its window to the new day at the same Texas clock time', async () => {
    // 10:00-10:30 a.m. on 5 October: CDT, UTC-5.
    const { rebook, tx } = build(
      {
        scheduledStartAt: new Date('2026-10-05T15:00:00.000Z'),
        scheduledEndAt: new Date('2026-10-05T15:30:00.000Z'),
      },
      { from: '2026-10-05', to: '2026-10-09' },
    );
    await expect(rebook()).resolves.toBe(1);

    const data = written(tx);
    expect(data.scheduledAt).toEqual(new Date('2026-10-09T00:00:00.000Z'));
    expect(data.scheduledStartAt).toEqual(new Date('2026-10-09T15:00:00.000Z'));
    expect(data.scheduledEndAt).toEqual(new Date('2026-10-09T15:30:00.000Z'));
    // Read back the way the push reads it: the new day, the old time.
    expect(businessDate(data.scheduledStartAt!)).toBe('2026-10-09');
    expect(businessClockTime(data.scheduledStartAt!)).toBe('10:00:00');
    expect(businessClockTime(data.scheduledEndAt!)).toBe('10:30:00');
  });

  it('keeps the clock time, not the UTC offset, across the change to CST', async () => {
    // Texas leaves daylight saving on 1 November 2026. 10 a.m. on 30 October is
    // 15:00 UTC; 10 a.m. on 3 November is 16:00 UTC. Carrying the instant's
    // offset over would put the visit at 9 a.m.
    const { rebook, tx } = build(
      {
        scheduledStartAt: new Date('2026-10-30T15:00:00.000Z'),
        scheduledEndAt: new Date('2026-10-30T15:30:00.000Z'),
      },
      { from: '2026-10-30', to: '2026-11-03' },
    );
    await rebook();

    const data = written(tx);
    expect(data.scheduledStartAt).toEqual(new Date('2026-11-03T16:00:00.000Z'));
    expect(data.scheduledEndAt).toEqual(new Date('2026-11-03T16:30:00.000Z'));
    expect(businessClockTime(data.scheduledStartAt!)).toBe('10:00:00');
  });

  it('still tells Jobber, through the reschedule the push reads the window for', async () => {
    const { rebook, tx } = build(
      {
        scheduledStartAt: new Date('2026-10-05T15:00:00.000Z'),
        scheduledEndAt: new Date('2026-10-05T15:30:00.000Z'),
      },
      { from: '2026-10-05', to: '2026-10-09' },
    );
    await rebook();

    expect(tx.jobberOutboundTask.upsert).toHaveBeenCalledTimes(1);
    expect(tx.jobberOutboundTask.upsert.mock.calls[0][0].create.kind).toBe(
      JobberOutboundKind.VISIT_RESCHEDULE,
    );
  });

  it('queues nothing while console edits are not pushed, and still moves the inspection', async () => {
    process.env.JOBBER_PUSH_EDITS_ENABLED = 'false';
    process.env.JOBBER_BOOKING_ENABLED = 'false';
    const { rebook, tx } = build(
      {
        scheduledStartAt: new Date('2026-10-05T15:00:00.000Z'),
        scheduledEndAt: new Date('2026-10-05T15:30:00.000Z'),
      },
      { from: '2026-10-05', to: '2026-10-09' },
    );
    await expect(rebook()).resolves.toBe(1);

    expect(tx.jobberOutboundTask.upsert).not.toHaveBeenCalled();
    expect(tx.inspection.update).toHaveBeenCalled();
  });
});

describe('a rebuild moving a whole-day visit', () => {
  it('moves only the day, and gives it no window', async () => {
    // How every published TBP visit goes out.
    const { rebook, tx } = build(
      { scheduledStartAt: null, scheduledEndAt: null },
      { from: '2026-10-05', to: '2026-10-09' },
    );
    await rebook();

    expect(tx.inspection.update).toHaveBeenCalledWith({
      where: { id: INSPECTION },
      data: { scheduledAt: new Date('2026-10-09T00:00:00.000Z') },
    });
  });
});

describe('a rebuild that leaves a visit where it was', () => {
  it('neither reads nor writes the window', async () => {
    const { rebook, tx } = build(
      {
        scheduledStartAt: new Date('2026-10-05T15:00:00.000Z'),
        scheduledEndAt: new Date('2026-10-05T15:30:00.000Z'),
      },
      { from: '2026-10-05', to: '2026-10-05' },
    );
    await expect(rebook()).resolves.toBe(0);

    expect(tx.inspection.findUnique).not.toHaveBeenCalled();
    expect(tx.inspection.update).not.toHaveBeenCalled();
  });
});
