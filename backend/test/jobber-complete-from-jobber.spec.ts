import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { InspectionStatus } from '@prisma/client';

import {
  JobberSyncWorker,
  type JobberSyncResult,
} from '../src/workers/jobber-sync/jobber-sync.worker';
import type { JobberVisit } from '../src/integrations/jobber/jobber.schemas';

/**
 * Technicians are still closing work in Jobber while this app is rolled out,
 * so the common case is a visit finished there that was never opened here.
 * Without this the inspection sits SCHEDULED for ever — the sync window only
 * reaches seven days back, so once the visit falls out of it nothing ever
 * looks at that inspection again.
 */
const visit = (completedAt: string | null, visitStatus = 'COMPLETED'): JobberVisit =>
  ({
    id: 'visit-1',
    completedAt,
    visitStatus,
    startAt: '2026-09-01T05:00:00Z',
  }) as unknown as JobberVisit;

const emptyResult = (): JobberSyncResult => ({
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
});

type InspectionRow = { id: string; status: InspectionStatus; startedAt: Date | null };

function workerWith(updatedCount = 1) {
  const tx = {
    inspection: { updateMany: jest.fn().mockResolvedValue({ count: updatedCount }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const worker = new JobberSyncWorker(prisma as never, {} as never, {} as never);
  // Reached directly: it is private, and the alternative is standing up the
  // whole paged run to exercise nine lines of branch.
  const invoke = (
    worker as unknown as {
      completeFromJobber: (
        organizationId: string,
        visit: JobberVisit,
        inspection: InspectionRow,
        result: JobberSyncResult,
      ) => Promise<void>;
    }
  ).completeFromJobber.bind(worker);

  const complete = async (
    inspection: InspectionRow,
    v: JobberVisit = visit('2026-09-01T17:05:07Z'),
    result = emptyResult(),
  ) => {
    await invoke('org-1', v, inspection, result);
    return result;
  };
  return { tx, complete };
}

const updateData = (tx: { inspection: { updateMany: jest.Mock } }) =>
  tx.inspection.updateMany.mock.calls[0][0].data as Record<string, unknown>;

const scheduled: InspectionRow = {
  id: 'insp-1',
  status: InspectionStatus.SCHEDULED,
  startedAt: null,
};

describe('closing an inspection because Jobber finished the visit', () => {
  it('marks it COMPLETED without finalizing it', async () => {
    // finalizedAt is an administrator sign-off on a report, it freezes the
    // evidence permanently, and spec §11 reserves it for a human. A webhook may
    // not claim it — least of all for an inspection holding no evidence at all.
    const { tx, complete } = workerWith();
    const result = await complete(scheduled);

    expect(updateData(tx).status).toBe(InspectionStatus.COMPLETED);
    expect(updateData(tx)).not.toHaveProperty('finalizedAt');
    expect(updateData(tx)).not.toHaveProperty('finalizedById');
    expect(result.completedFromJobber).toBe(1);
  });

  it('records the Jobber completion time, not the moment the sync happened to run', async () => {
    // The window reaches seven days back, so a completion is routinely seen
    // days late. Stamping now would put the wrong date on finished work.
    const { tx, complete } = workerWith();
    await complete(scheduled);
    expect((updateData(tx).completedAt as Date).toISOString()).toBe('2026-09-01T17:05:07.000Z');
  });

  it('leaves work already started in this app alone', async () => {
    // Once a technician has started, this app holds evidence and its own
    // lifecycle owns the outcome — an administrator finalizes it.
    const { tx, complete } = workerWith();
    const result = await complete({
      id: 'insp-1',
      status: InspectionStatus.IN_PROGRESS,
      startedAt: new Date('2026-09-01T14:00:00Z'),
    });
    expect(tx.inspection.updateMany).not.toHaveBeenCalled();
    expect(result.completedFromJobber).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('does not act on the echo of our own completion push', async () => {
    // Submitting pushes visitComplete to Jobber, which fires VISIT_COMPLETE
    // straight back at us. Without this guard that round trip would rewrite a
    // submitted inspection behind the reviewer's back.
    const { tx, complete } = workerWith();
    for (const status of [
      InspectionStatus.TECHNICIAN_SUBMITTED,
      InspectionStatus.REVIEW_REQUIRED,
      InspectionStatus.COMPLETED,
    ])
      await complete({ id: 'insp-1', status, startedAt: new Date() });
    expect(tx.inspection.updateMany).not.toHaveBeenCalled();
  });

  it('re-asserts the status in the WHERE clause, not only in the read', async () => {
    // The read runs outside the transaction, so a technician who starts the
    // inspection in between would otherwise have their work closed underneath
    // them by a webhook.
    const { tx, complete } = workerWith();
    await complete(scheduled);
    const where = tx.inspection.updateMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.status).toBe(InspectionStatus.SCHEDULED);
    expect(where.startedAt).toBeNull();
    expect(where.organizationId).toBe('org-1');
  });

  it('writes no audit row when that race is lost', async () => {
    const { tx, complete } = workerWith(0);
    const result = await complete(scheduled);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(result.completedFromJobber).toBe(0);
  });

  it('records that no inspection was actually carried out here', async () => {
    // The point of the audit row: there is no report behind this completion,
    // and a later reader must not assume there is one.
    const { tx, complete } = workerWith();
    await complete(scheduled);
    const data = tx.auditLog.create.mock.calls[0][0].data as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(data.action).toBe('INSPECTION_COMPLETED_FROM_JOBBER');
    expect(data.metadata.capturedInApp).toBe(false);
  });

  it('trusts a completedAt timestamp even when the status label says otherwise', async () => {
    // visitStatus is a derived label Jobber may add values to; completedAt is a
    // fact. The same rule the import path already applies.
    const { tx, complete } = workerWith();
    await complete(scheduled, visit('2026-09-01T17:05:07Z', 'LATE'));
    expect(tx.inspection.updateMany).toHaveBeenCalled();
  });

  it('falls back to now when Jobber reports completion with no timestamp', async () => {
    const { tx, complete } = workerWith();
    await complete(scheduled, visit(null, 'COMPLETED'));
    expect(updateData(tx).completedAt).toBeInstanceOf(Date);
  });
});

describe('where the completion check sits in applyChanges', () => {
  const WORKER = readFileSync(
    join(__dirname, '..', 'src', 'workers', 'jobber-sync', 'jobber-sync.worker.ts'),
    'utf8',
  );

  it('runs before the reschedule comparison', () => {
    // A completed visit is not a move. Comparing its window would either do
    // nothing or mistake the completion for a change of plan.
    const completion = WORKER.indexOf('this.completeFromJobber');
    const reschedule = WORKER.indexOf('const window = visitWindow(visit)');
    expect(completion).toBeGreaterThan(-1);
    expect(reschedule).toBeGreaterThan(completion);
  });

  it('runs after assignment is reconciled, so we still record who did the work', () => {
    const assignment = WORKER.indexOf(
      'await this.applyAssignment(organizationId, visit, inspectionId, result)',
    );
    expect(assignment).toBeGreaterThan(-1);
    expect(WORKER.indexOf('this.completeFromJobber')).toBeGreaterThan(assignment);
  });
});
