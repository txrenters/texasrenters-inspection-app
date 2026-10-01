import { InspectionStatus, JobberVisitImportStatus } from '@prisma/client';

import type { JobberVisit } from '../src/integrations/jobber/jobber.schemas';
import {
  JOBBER_VISIT_MISSING,
  JOBBER_VISIT_UNSCHEDULED,
  JobberSyncWorker,
  type JobberSyncResult,
} from '../src/workers/jobber-sync/jobber-sync.worker';

/**
 * Visits that leave Jobber's calendar: moved to Unscheduled, deleted, or gone
 * from the sweep's window some other way. Before 2026-10-01 each left its
 * inspection on the old day -- Moses's October 1 showed seven stops against
 * Jobber's six. Ids and addresses invented.
 */

const ORG = '00000000-0000-4000-8000-000000000001';

const result = (): JobberSyncResult => ({
  correlationId: 'c1',
  visitsSeen: 0,
  imported: 0,
  rescheduled: 0,
  unmatched: 0,
  rejected: 0,
  alreadyComplete: 0,
  notSynced: 0,
  assigned: 0,
  completedFromJobber: 0,
  withdrawn: 0,
  skipped: 0,
  truncated: false,
});

type Internals = {
  applyAssignment: jest.Mock;
  applyChanges: (
    organizationId: string,
    visit: JobberVisit,
    inspectionId: string,
    result: JobberSyncResult,
    stored?: { payload?: unknown; failureCode?: string | null },
  ) => Promise<void>;
};

function changesFor(inspection: Record<string, unknown>) {
  const tx = {
    inspection: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    jobberVisitImport: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    tbpQuarterPlanStop: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
  };
  const prisma = {
    jobberOutboundTask: { findMany: jest.fn().mockResolvedValue([]) },
    jobberVisitImport: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    inspection: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'inspection-1',
        status: InspectionStatus.SCHEDULED,
        startedAt: null,
        scheduledAt: new Date('2026-10-01T00:00:00Z'),
        scheduledStartAt: null,
        scheduledEndAt: null,
        jobberVisitTitle: 'Title',
        jobberVisitDetails: null,
        ...inspection,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn((work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const worker = new JobberSyncWorker(prisma as never, {} as never, {} as never) as unknown as Internals;
  worker.applyAssignment = jest.fn().mockResolvedValue(undefined);
  return { worker, prisma, tx };
}

const visit = (fields: Partial<JobberVisit> = {}): JobberVisit =>
  ({ id: 'visit-1', title: 'Title', startAt: null, endAt: null, allDay: true, ...fields }) as JobberVisit;

describe('a visit moved to Unscheduled in Jobber', () => {
  it('takes its inspection off the day, marked so it can come back', async () => {
    const { worker, tx } = changesFor({});
    const outcome = result();

    await worker.applyChanges(ORG, visit(), 'inspection-1', outcome);

    expect(tx.inspection.updateMany).toHaveBeenCalledWith({
      where: { id: 'inspection-1', organizationId: ORG, status: InspectionStatus.SCHEDULED, startedAt: null },
      data: expect.objectContaining({ status: InspectionStatus.CANCELLED }),
    });
    expect(tx.jobberVisitImport.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, jobberVisitId: 'visit-1' },
      data: expect.objectContaining({ failureCode: JOBBER_VISIT_UNSCHEDULED }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'INSPECTION_CANCELLED',
          metadata: { jobberVisitId: 'visit-1', reason: 'JOBBER_VISIT_UNSCHEDULED' },
        }),
      }),
    );
    expect(outcome.withdrawn).toBe(1);
  });

  it('leaves work already under way for a person', async () => {
    const { worker, prisma } = changesFor({
      status: InspectionStatus.IN_PROGRESS,
      startedAt: new Date('2026-10-01T14:00:00Z'),
    });
    const outcome = result();

    await worker.applyChanges(ORG, visit(), 'inspection-1', outcome);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.jobberVisitImport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ failureCode: 'JOBBER_RESCHEDULE_NEEDS_REVIEW' }) }),
    );
    expect(outcome.withdrawn).toBe(0);
  });

  it('brings the same inspection back on the day Jobber gives it', async () => {
    const { worker, tx } = changesFor({ status: InspectionStatus.CANCELLED });
    const outcome = result();

    await worker.applyChanges(ORG, visit({ startAt: '2026-10-06T05:00:00Z' }), 'inspection-1', outcome, {
      failureCode: JOBBER_VISIT_UNSCHEDULED,
    });

    expect(tx.inspection.updateMany).toHaveBeenCalledWith({
      where: { id: 'inspection-1', organizationId: ORG, status: InspectionStatus.CANCELLED },
      data: {
        status: InspectionStatus.SCHEDULED,
        cancelledAt: null,
        cancellationReason: null,
        scheduledAt: new Date('2026-10-06T00:00:00Z'),
        scheduledStartAt: null,
        scheduledEndAt: null,
      },
    });
    expect(tx.jobberVisitImport.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, jobberVisitId: 'visit-1' },
      data: { failureCode: null, failureMessage: null },
    });
    expect(outcome.rescheduled).toBe(1);
  });

  it('stays off while Jobber still has it on no day', async () => {
    const { worker, prisma } = changesFor({ status: InspectionStatus.CANCELLED });

    await worker.applyChanges(ORG, visit(), 'inspection-1', result(), { failureCode: JOBBER_VISIT_UNSCHEDULED });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('never brings back an inspection somebody cancelled', async () => {
    const { worker, prisma } = changesFor({ status: InspectionStatus.CANCELLED });

    await worker.applyChanges(ORG, visit({ startAt: '2026-10-06T05:00:00Z' }), 'inspection-1', result());

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('a visit an inspection carries, whose row says it was never imported', () => {
  // A visit on Moses's October 1: a linked inspection, and a row still
  // reading "not imported, no day yet", so Jobber's Unscheduled never reached it.
  function processing(row: { status: JobberVisitImportStatus; inspectionId: string | null; failureCode: string | null }) {
    const prisma = {
      jobberVisitImport: {
        findUnique: jest.fn().mockResolvedValue({ id: 'row-1', payload: { id: 'visit-1' }, ...row }),
        upsert: jest.fn().mockResolvedValue({ id: 'row-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      inspection: { findFirst: jest.fn().mockResolvedValue({ id: 'inspection-1' }) },
    };
    const worker = new JobberSyncWorker(prisma as never, {} as never, {} as never) as unknown as {
      applyChanges: jest.Mock;
      processVisit: (
        organizationId: string,
        visit: JobberVisit,
        index: Map<string, unknown>,
        rules: Record<string, string[]>,
        result: JobberSyncResult,
      ) => Promise<void>;
    };
    worker.applyChanges = jest.fn().mockResolvedValue(undefined);
    return { worker, prisma };
  }

  it('is put right and handled as the imported visit it is', async () => {
    const { worker, prisma } = processing({
      status: JobberVisitImportStatus.PENDING,
      inspectionId: null,
      failureCode: JOBBER_VISIT_UNSCHEDULED,
    });

    await worker.processVisit(ORG, visit(), new Map(), {}, result());

    expect(prisma.inspection.findFirst).toHaveBeenCalledWith({
      where: { organizationId: ORG, jobberVisitId: 'visit-1' },
      select: { id: true },
    });
    expect(prisma.jobberVisitImport.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: {
        status: JobberVisitImportStatus.IMPORTED,
        inspectionId: 'inspection-1',
        failureCode: null,
        failureMessage: null,
      },
    });
    // Its "no day yet" code is not passed on: it says nothing about the inspection.
    expect(worker.applyChanges).toHaveBeenCalledWith(ORG, expect.objectContaining({ id: 'visit-1' }), 'inspection-1', expect.anything(), {
      payload: { id: 'visit-1' },
    });
  });

  it('is left alone when the row already names it', async () => {
    const { worker, prisma } = processing({
      status: JobberVisitImportStatus.IMPORTED,
      inspectionId: 'inspection-1',
      failureCode: null,
    });

    await worker.processVisit(ORG, visit(), new Map(), {}, result());

    expect(prisma.inspection.findFirst).not.toHaveBeenCalled();
    expect(prisma.jobberVisitImport.update).not.toHaveBeenCalled();
    expect(worker.applyChanges).toHaveBeenCalledTimes(1);
  });
});

describe('the sweep, for linked visits its window did not return', () => {
  type Linked = { id: string; jobberVisitId: string; jobberJobId: string | null };
  const linked = (n: number): Linked => ({ id: `inspection-${n}`, jobberVisitId: `visit-${n}`, jobberJobId: `job-${n}` });

  function sweep({
    window = [],
    inspections,
    byId = [],
    missedBefore = [],
  }: {
    window?: string[];
    inspections: Linked[];
    byId?: string[];
    missedBefore?: string[];
  }) {
    const prisma = {
      jobberConnection: {
        findUnique: jest.fn().mockResolvedValue({ status: 'CONNECTED' }),
        update: jest.fn().mockResolvedValue({}),
      },
      inspection: {
        findMany: jest
          .fn()
          .mockResolvedValue(inspections.map((row) => ({ ...row, status: InspectionStatus.SCHEDULED, startedAt: null }))),
      },
      jobberVisitImport: {
        findMany: jest.fn(({ where }: { where: { jobberVisitId: { in: string[] } } }) =>
          Promise.resolve(
            where.jobberVisitId.in.map((jobberVisitId) => ({
              jobberVisitId,
              failureCode: missedBefore.includes(jobberVisitId) ? JOBBER_VISIT_MISSING : null,
            })),
          ),
        ),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const page = (ids: string[]) => ({
      visits: { nodes: ids.map((id) => visit({ id })), pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const client = {
      requestDetailed: jest.fn().mockResolvedValue({ data: page(window), cost: undefined }),
      request: jest.fn().mockResolvedValue(page(byId)),
    };
    const mapping = { buildingIndex: jest.fn().mockResolvedValue(new Map()) };
    const worker = new JobberSyncWorker(prisma as never, client as never, mapping as never);
    const internals = worker as unknown as { processVisit: jest.Mock; withdrawFromDay: jest.Mock };
    internals.processVisit = jest.fn().mockResolvedValue(undefined);
    internals.withdrawFromDay = jest.fn().mockResolvedValue(undefined);
    return { worker, prisma, client, internals };
  }

  it('asks only for the linked visits it did not see, and handles the ones Jobber returns', async () => {
    const { worker, client, internals } = sweep({
      window: ['visit-1'],
      inspections: [linked(1), linked(2)],
      // Moved outside the window: Jobber has it, on another day.
      byId: ['visit-2'],
    });

    await worker.run(ORG);

    expect(client.request.mock.calls[0][2]).toEqual({ ids: ['visit-2'] });
    const handled = internals.processVisit.mock.calls.map((call) => call[1].id);
    expect(handled).toEqual(['visit-1', 'visit-2']);
    expect(internals.withdrawFromDay).not.toHaveBeenCalled();
  });

  it('marks a visit Jobber did not return, and withdraws nothing on one miss', async () => {
    const { worker, prisma, internals } = sweep({
      window: ['visit-1'],
      inspections: [linked(1), linked(2), linked(3)],
      byId: ['visit-3'],
    });

    await worker.run(ORG);

    expect(prisma.jobberVisitImport.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.jobberVisitImport.upsert.mock.calls[0][0]).toMatchObject({
      where: { organizationId_jobberVisitId: { organizationId: ORG, jobberVisitId: 'visit-2' } },
      create: {
        status: JobberVisitImportStatus.IMPORTED,
        inspectionId: 'inspection-2',
        failureCode: JOBBER_VISIT_MISSING,
      },
      update: { failureCode: JOBBER_VISIT_MISSING },
    });
    expect(internals.withdrawFromDay).not.toHaveBeenCalled();
  });

  it('takes it off its day when the next sweep finds the same', async () => {
    const { worker, internals } = sweep({
      inspections: [linked(2), linked(3)],
      byId: ['visit-3'],
      missedBefore: ['visit-2'],
    });

    await worker.run(ORG);

    expect(internals.withdrawFromDay).toHaveBeenCalledTimes(1);
    expect(internals.withdrawFromDay.mock.calls[0].slice(0, 2)).toEqual([ORG, 'visit-2']);
    expect(internals.withdrawFromDay.mock.calls[0][3]).toBe('MISSING');
  });

  it('marks nothing when Jobber returns none of several visits it was asked for', async () => {
    const { worker, prisma, internals } = sweep({
      inspections: [linked(1), linked(2), linked(3), linked(4)],
      missedBefore: ['visit-1', 'visit-2', 'visit-3', 'visit-4'],
    });

    await worker.run(ORG);

    expect(prisma.jobberVisitImport.upsert).not.toHaveBeenCalled();
    expect(internals.withdrawFromDay).not.toHaveBeenCalled();
  });

  it('withdraws nothing when more are missing at once than a day plausibly deletes', async () => {
    const many = Array.from({ length: 16 }, (_, n) => linked(n + 10));
    const { worker, internals } = sweep({
      window: ['visit-1'],
      inspections: [linked(1), ...many],
      byId: [],
      missedBefore: many.map((row) => row.jobberVisitId),
    });
    // One visit Jobber did return, so the answer is about the visits, not the query.
    const withOne = sweep({
      window: [],
      inspections: [linked(1), ...many],
      byId: ['visit-1'],
      missedBefore: many.map((row) => row.jobberVisitId),
    });

    await worker.run(ORG);
    await withOne.worker.run(ORG);

    expect(internals.withdrawFromDay).not.toHaveBeenCalled();
    expect(withOne.internals.withdrawFromDay).not.toHaveBeenCalled();
  });

  it('never fails a sweep whose window was read, when the look afterwards fails', async () => {
    const { worker, prisma, client, internals } = sweep({ window: ['visit-1'], inspections: [linked(1), linked(2)] });
    client.request.mockRejectedValue(new Error('Throttled'));

    await expect(worker.run(ORG)).resolves.toMatchObject({ visitsSeen: 1 });
    expect(prisma.jobberConnection.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastSyncCompletedAt: expect.any(Date) }) }),
    );
    expect(internals.withdrawFromDay).not.toHaveBeenCalled();
  });

  it('leaves a backfill of a fixed slice alone', async () => {
    const { worker, prisma } = sweep({ inspections: [linked(2)] });

    await worker.run(ORG, { startAfter: '2026-07-01T00:00:00.000Z', startBefore: '2026-10-01T00:00:00.000Z' });

    expect(prisma.inspection.findMany).not.toHaveBeenCalled();
  });
});
