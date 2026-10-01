import { UserRole } from '@texasrenters/shared';
import { JobberOutboundKind, JobberVisitImportStatus } from '@prisma/client';

import { AdminService } from '../src/admin/admin.service';
import type { AuthenticatedUser } from '../src/common/auth';
import { PresenceService } from '../src/realtime/presence.service';

/**
 * A planned visit deleted in the console goes from Jobber too (the office,
 * 2026-10-01: a visit deleted on either side goes from both). People and ids
 * invented.
 */

const user: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-coordinator',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Coordinator',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: ['inspections:delete'],
  mustChangePassword: false,
  principalType: 'USER',
};

/**
 * Every table the erase touches, answering "nothing there" -- except the ones
 * this spec is about, which are recorded.
 */
function build(inspection: { status: string; jobberVisitId: string | null; jobberJobId: string | null }) {
  const recorded = {
    jobberOutboundTask: { create: jest.fn().mockResolvedValue({ id: 'task-1' }) },
    jobberVisitImport: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    inspection: {
      findUnique: jest.fn().mockResolvedValue(inspection),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const empty = () => jest.fn().mockResolvedValue({ count: 0 });
  const tx = new Proxy(recorded as Record<string, unknown>, {
    get: (target, table: string) =>
      target[table] ?? (target[table] = { deleteMany: empty(), updateMany: empty() }),
  });
  const prisma = {
    inspection: { findFirst: jest.fn().mockResolvedValue({ id: 'inspection-1', ...inspection }) },
    inspectionMedia: { findMany: jest.fn().mockResolvedValue([]) },
    inspectionPhoto: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((work: (client: unknown) => unknown) => work(tx)),
  };
  return { service: new AdminService(prisma as never, new PresenceService()), recorded };
}

describe('deleting an inspection that has a Jobber visit', () => {
  const previous = { ...process.env };
  afterEach(() => {
    process.env = { ...previous };
  });

  it('queues the visit to come off Jobber, and lets go of the link', async () => {
    process.env.JOBBER_PUSH_EDITS_ENABLED = 'true';
    const { service, recorded } = build({ status: 'SCHEDULED', jobberVisitId: 'visit-9', jobberJobId: 'job-9' });

    await service.deleteInspection(user, 'inspection-1');

    expect(recorded.jobberOutboundTask.create).toHaveBeenCalledWith({
      data: {
        organizationId: user.organizationId,
        inspectionId: null,
        jobberVisitId: 'visit-9',
        jobberJobId: 'job-9',
        kind: JobberOutboundKind.VISIT_CANCEL,
        createdById: user.id,
      },
    });
    expect(recorded.jobberVisitImport.updateMany).toHaveBeenCalledWith({
      where: { organizationId: user.organizationId, jobberVisitId: 'visit-9' },
      data: { status: JobberVisitImportStatus.IGNORED, inspectionId: null },
    });
    expect(recorded.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'INSPECTION_DELETED',
          metadata: expect.objectContaining({ jobberVisitId: 'visit-9', removedFromJobber: true }),
        }),
      }),
    );
  });

  it('leaves Jobber alone for work already begun or done', async () => {
    process.env.JOBBER_PUSH_EDITS_ENABLED = 'true';
    const { service, recorded } = build({ status: 'COMPLETED', jobberVisitId: 'visit-9', jobberJobId: 'job-9' });

    await service.deleteInspection(user, 'inspection-1');

    expect(recorded.jobberOutboundTask.create).not.toHaveBeenCalled();
  });

  it("leaves Jobber's calendar alone while console edits are not pushed", async () => {
    process.env.JOBBER_PUSH_EDITS_ENABLED = 'false';
    const { service, recorded } = build({ status: 'SCHEDULED', jobberVisitId: 'visit-9', jobberJobId: 'job-9' });

    await service.deleteInspection(user, 'inspection-1');

    expect(recorded.jobberOutboundTask.create).not.toHaveBeenCalled();
    expect(recorded.jobberVisitImport.updateMany).not.toHaveBeenCalled();
  });
});
