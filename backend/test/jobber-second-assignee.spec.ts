import { InspectionStatus } from '@prisma/client';

import type { JobberVisit } from '../src/integrations/jobber/jobber.schemas';
import { JobberSyncWorker, type JobberSyncResult } from '../src/workers/jobber-sync/jobber-sync.worker';

/**
 * A second technician added to a Jobber visit.
 *
 * 2026-10-28: a coordinator put a second technician on two benefit-package
 * visits beside the one who already had them. Jobber listed the newcomer first,
 * the sync took the first technician it recognised, and both inspections left
 * the first technician's phone, who reached the door of one with nothing in
 * the app to open. People and ids here are invented.
 */

const MOSES = { id: 'tech-moses', email: 'moses@example.com' };
const AMY = { id: 'tech-amy', email: 'amy@example.com' };

const visit = (...people: Array<{ email: string }>) =>
  ({
    id: 'visit-1',
    assignedUsers: {
      nodes: people.map((person, index) => ({
        id: `jobber-user-${index}`,
        email: { raw: person.email },
        name: { full: null },
      })),
    },
  }) as unknown as JobberVisit;

function sync({ current, technicians }: { current: string | null; technicians: Array<{ id: string; email: string }> }) {
  const tx = {
    inspectionAssignment: { update: jest.fn().mockResolvedValue({}), create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    inspection: {
      findFirst: jest.fn().mockResolvedValue({ startedAt: null, status: InspectionStatus.SCHEDULED }),
    },
    inspectionAssignment: {
      findFirst: jest.fn().mockResolvedValue(current ? { id: 'assignment-1', technicianId: current } : null),
    },
    userProfile: { findMany: jest.fn().mockResolvedValue(technicians) },
    jobberVisitImport: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn((work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const worker = new JobberSyncWorker(prisma as never, {} as never, {} as never) as unknown as {
    applyAssignment: (
      organizationId: string,
      visit: JobberVisit,
      inspectionId: string,
      result: JobberSyncResult,
    ) => Promise<void>;
  };
  const result = { assigned: 0 } as JobberSyncResult;
  return {
    tx,
    result,
    run: (jobber: JobberVisit) => worker.applyAssignment('org-1', jobber, 'inspection-1', result),
  };
}

describe('a second technician added to a visit in Jobber', () => {
  it('leaves the inspection with the technician who already has it', async () => {
    const { tx, result, run } = sync({ current: MOSES.id, technicians: [MOSES, AMY] });

    await run(visit(AMY, MOSES));

    expect(tx.inspectionAssignment.update).not.toHaveBeenCalled();
    expect(tx.inspectionAssignment.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(result.assigned).toBe(0);
  });

  it('moves it once Jobber no longer names that technician', async () => {
    // Taking the first technician off the visit is the coordinator handing the job over.
    const { tx, result, run } = sync({ current: MOSES.id, technicians: [AMY] });

    await run(visit(AMY));

    expect(tx.inspectionAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isCurrent: false, status: 'UNASSIGNED' }) }),
    );
    expect(tx.inspectionAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ technicianId: AMY.id }) }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'INSPECTION_REASSIGNED_FROM_JOBBER' }) }),
    );
    expect(result.assigned).toBe(1);
  });

  it('still gives an unassigned inspection to the first technician Jobber lists', async () => {
    const { tx, run } = sync({ current: null, technicians: [MOSES, AMY] });

    await run(visit(AMY, MOSES));

    expect(tx.inspectionAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ technicianId: AMY.id }) }),
    );
  });
});
