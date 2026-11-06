import { UserRole } from '@texasrenters/shared';

import { ReportShareService } from '../src/admin/report-share.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Open report (2026-11-07): the office reads a job's report without creating a
 * link to send. An hour's link of its own, kept out of the links listed for
 * sharing, and reused rather than left in a trail. Ids and names invented.
 */

const ORG = '40000000-0000-4000-8000-000000000001';
const JOB = '40000000-0000-4000-8000-000000000010';
const ME = '40000000-0000-4000-8000-000000000030';
const HOUR = 60 * 60 * 1000;

const person: AuthenticatedUser = {
  id: ME,
  authUserId: 'auth-me',
  organizationId: ORG,
  displayName: 'Ada Lane',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: ['inspections:read'],
  mustChangePassword: false,
  principalType: 'USER',
};

function harness(live: { token: string } | null = null, job: { id: string } | null = { id: JOB }) {
  const tx = {
    inspectionReportShare: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'share-1', ...data })),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    inspection: { findFirst: jest.fn().mockResolvedValue(job) },
    inspectionReportShare: {
      findFirst: jest.fn().mockResolvedValue(live),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
  };
  const service = new ReportShareService(prisma as never, undefined as never);
  return { tx, prisma, service };
}

describe('Open report', () => {
  it('makes a link of its own, for an hour, with nobody to send it to', async () => {
    const { tx, service } = harness();
    const before = Date.now();

    const { sharePath } = await service.openReport(person, JOB);

    const data = tx.inspectionReportShare.create.mock.calls[0]![0].data as Record<string, unknown> & { expiresAt: Date };
    expect(data).toMatchObject({
      organizationId: ORG,
      inspectionId: JOB,
      createdById: ME,
      kind: 'INSPECTION',
      preview: true,
    });
    expect(data).not.toHaveProperty('recipientEmail');
    expect(data.expiresAt.getTime() - before).toBeGreaterThanOrEqual(HOUR - 1000);
    expect(data.expiresAt.getTime() - before).toBeLessThanOrEqual(HOUR + 1000);
    expect(sharePath).toBe(`/report/${data.token as string}`);
  });

  it('goes on the job’s history', async () => {
    const { tx, service } = harness();
    await service.openReport(person, JOB);
    expect(tx.auditLog.create.mock.calls[0]![0].data).toMatchObject({
      organizationId: ORG,
      actorUserId: ME,
      action: 'REPORT_PREVIEW_OPENED',
      entityType: 'Inspection',
      entityId: JOB,
    });
  });

  it('answers with the link already open, rather than leaving a trail of them', async () => {
    const { tx, service } = harness({ token: 'still-good' });

    await expect(service.openReport(person, JOB)).resolves.toEqual({ sharePath: '/report/still-good' });

    expect(tx.inspectionReportShare.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('reuses only this person’s link on this job, and only one with time left', async () => {
    const { prisma, service } = harness({ token: 'still-good' });
    const before = Date.now();

    await service.openReport(person, JOB);

    const { where } = prisma.inspectionReportShare.findFirst.mock.calls[0]![0] as {
      where: Record<string, unknown> & { expiresAt: { gt: Date } };
    };
    expect(where).toMatchObject({
      inspectionId: JOB,
      organizationId: ORG,
      createdById: ME,
      preview: true,
      revokedAt: null,
    });
    expect(where.expiresAt.gt.getTime()).toBeGreaterThan(before);
  });

  it('will not open a job from another organization', async () => {
    const { prisma, tx, service } = harness(null, null);

    await expect(service.openReport(person, JOB)).rejects.toMatchObject({ code: 'INSPECTION_NOT_FOUND' });

    expect(prisma.inspection.findFirst.mock.calls[0]![0].where).toEqual({ id: JOB, organizationId: ORG });
    expect(tx.inspectionReportShare.create).not.toHaveBeenCalled();
  });

  it('refuses an integration: a link needs a person behind it', async () => {
    const { tx, service } = harness();

    await expect(
      service.openReport({ ...person, principalType: 'API_KEY', apiClientId: ME }, JOB),
    ).rejects.toMatchObject({ code: 'REPORT_PREVIEW_NOT_PERMITTED' });

    expect(tx.inspectionReportShare.create).not.toHaveBeenCalled();
  });

  it('stays out of the links listed for sharing', async () => {
    const { prisma, service } = harness();
    await service.listShares(person, JOB);
    expect(prisma.inspectionReportShare.findMany.mock.calls[0]![0].where).toMatchObject({ preview: false });
  });
});
