import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { ReportShareService } from '../src/admin/report-share.service';

/**
 * The move-in / move-out comparison, sent to owners and tenants by link (the
 * office, 2026-10-06), as the inspection report is.
 *
 * What is held to: a link serves the document it was created for, and nothing
 * else, brought up to date before it is read or sent. Nothing waits on an
 * approval -- there is none (the office, 2026-10-07): the comparison is drawn
 * from the checklists and the findings the office confirmed.
 */

const admin: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000002',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Office Admin',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: ['reports:share'],
  mustChangePassword: false,
  principalType: 'USER',
};

const COMPARISON = { id: 'comparison-1', moveOutInspectionId: 'move-out-1', moveInInspectionId: 'move-in-1' };

function harness(opts: { comparison?: Record<string, unknown> | null } = {}) {
  const tx = {
    inspectionReportShare: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'share-1',
        createdAt: new Date(),
        revokedAt: null,
        ...data,
      })),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    inspection: { findFirst: jest.fn().mockResolvedValue({ id: 'move-out-1' }) },
    inspectionComparison: {
      findFirst: jest
        .fn()
        .mockResolvedValue(opts.comparison === undefined ? COMPARISON : opts.comparison),
    },
    inspectionReportShare: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const mailer = { sendReportShare: jest.fn().mockResolvedValue({ status: 'SENT' }) };
  const comparisons = { current: jest.fn().mockResolvedValue(undefined) };
  const comparisonReport = { reportForShare: jest.fn().mockResolvedValue({ areas: [] }) };
  const service = new ReportShareService(
    prisma as never,
    mailer as never,
    undefined,
    comparisonReport as never,
    comparisons as never,
  );
  return { service, prisma, tx, mailer, comparisons, comparisonReport };
}

describe('issuing a comparison link', () => {
  it('issues one as soon as there is a comparison, current, and emails its own words', async () => {
    const { service, tx, mailer, comparisons } = harness();

    const share = await service.createShare(admin, 'move-out-1', 'Tenant@Example.com', 'COMPARISON' as never);

    expect(share.kind).toBe('COMPARISON');
    expect(share.sharePath).toBe(`/comparison-report/${share.token}`);
    expect(tx.inspectionReportShare.create.mock.calls[0][0].data).toMatchObject({ kind: 'COMPARISON' });
    // Sending it is the person's decision, and the audit log has it.
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'REPORT_SHARE_CREATED',
      actorUserId: admin.id,
      metadata: expect.objectContaining({ kind: 'COMPARISON' }),
    });
    expect(comparisons.current).toHaveBeenCalledWith(admin.organizationId, 'move-out-1');
    expect(mailer.sendReportShare).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'tenant@example.com',
        kind: 'COMPARISON',
        reportUrl: expect.stringMatching(/\/comparison-report\/[\w-]+$/),
      }),
    );
  });

  it('refuses before a comparison exists, and says when one will', async () => {
    const { service, tx } = harness({ comparison: null });
    await expect(
      service.createShare(admin, 'move-out-1', undefined, 'COMPARISON' as never),
    ).rejects.toMatchObject({
      status: 404,
      code: 'COMPARISON_NOT_FOUND',
      message: expect.stringContaining('once the move-out is submitted'),
    });
    expect(tx.inspectionReportShare.create).not.toHaveBeenCalled();
  });

  it('leaves an inspection link as it always was', async () => {
    const { service, comparisons, mailer } = harness({ comparison: null });

    const share = await service.createShare(admin, 'move-out-1', 'owner@example.com');

    expect(share.kind).toBe('INSPECTION');
    expect(share.sharePath).toBe(`/report/${share.token}`);
    expect(comparisons.current).not.toHaveBeenCalled();
    expect(mailer.sendReportShare).toHaveBeenCalledWith(expect.objectContaining({ kind: 'INSPECTION' }));
  });

  it('lists one document’s links when asked for one', async () => {
    const { service, prisma } = harness();

    await service.listShares(admin, 'move-out-1', 'COMPARISON' as never);

    expect(prisma.inspectionReportShare.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { inspectionId: 'move-out-1', organizationId: admin.organizationId, kind: 'COMPARISON' },
      }),
    );
  });
});

describe('opening a comparison link', () => {
  function opened(kind: string | undefined) {
    const built = harness();
    Object.assign(built.prisma.inspectionReportShare, {
      findUnique: jest.fn().mockResolvedValue({
        inspectionId: 'move-out-1',
        organizationId: admin.organizationId,
        kind,
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: null,
        createdBy: { displayName: 'Office Admin' },
      }),
    });
    return built;
  }

  it('serves the comparison as it stands now, its photographs addressed through the token', async () => {
    const { service, comparisonReport, comparisons } = opened('COMPARISON');

    await expect(service.publicComparisonReport('token-1')).resolves.toEqual({ areas: [] });
    // Brought up to date first: a finding confirmed after the link went out
    // is on it the next time it is opened.
    expect(comparisons.current).toHaveBeenCalledWith(admin.organizationId, 'move-out-1');
    expect(comparisons.current.mock.invocationCallOrder[0]).toBeLessThan(
      comparisonReport.reportForShare.mock.invocationCallOrder[0],
    );
    expect(comparisonReport.reportForShare).toHaveBeenCalledWith(admin.organizationId, 'move-out-1', 'token-1');
  });

  it('says the link is gone when the comparison is', async () => {
    const built = opened('COMPARISON');
    built.prisma.inspectionComparison.findFirst.mockResolvedValue(null);

    await expect(built.service.publicComparisonReport('token-1')).rejects.toMatchObject({ status: 404 });
    expect(built.comparisonReport.reportForShare).not.toHaveBeenCalled();
  });

  it('serves a link only the document it was made for', async () => {
    // An inspection link cannot open the comparison...
    await expect(opened('INSPECTION').service.publicComparisonReport('token-1')).rejects.toMatchObject({
      status: 404,
    });
    // ...nor one issued before the column existed, which is an inspection link...
    await expect(opened(undefined).service.publicComparisonReport('token-1')).rejects.toMatchObject({
      status: 404,
    });
    // ...and a comparison link cannot open the move-out's own report.
    await expect(opened('COMPARISON').service.publicReport('token-1')).rejects.toMatchObject({
      status: 404,
      code: 'REPORT_NOT_AVAILABLE',
    });
  });

  it('reaches a photograph of either inspection it compares, and no other', async () => {
    const { service, prisma } = opened('COMPARISON');
    const findFirst = jest
      .fn()
      .mockResolvedValue({ id: 'photo-1', storageKey: 'key-1', mimeType: 'image/jpeg' });
    Object.assign(prisma, { inspectionPhoto: { findFirst } });
    const storage = { get: jest.fn().mockResolvedValue(Buffer.from('jpeg')) };
    Object.assign(service as unknown as { mediaStorage: unknown }, { mediaStorage: storage });

    await service.publicPhoto('token-1', 'photo-1');

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'photo-1',
          inspectionId: { in: ['move-in-1', 'move-out-1'] },
          // Still only what a homeowner may see.
          AND: { OR: [{ findingId: null }, { finding: { reviewStatus: 'APPROVED' } }] },
        }),
      }),
    );
  });
});
