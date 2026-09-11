import { UserRole } from '@texasrenters/shared';

import { ReportShareService } from '../src/admin/report-share.service';
import type { AuthenticatedUser } from '../src/common/auth';

const user: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Administrator',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
};

const live = { expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null };

function createPrisma(comparison: { status: string } | null) {
  const created: { data?: Record<string, unknown> } = {};
  const tx = {
    inspectionReportShare: {
      create: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
        created.data = args.data;
        return Promise.resolve({
          ...args.data,
          id: 'share-1',
          expiresAt: new Date('2026-12-01T00:00:00.000Z'),
          createdAt: new Date(),
          revokedAt: null,
        });
      }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  return {
    created,
    prisma: {
      inspection: { findFirst: jest.fn().mockResolvedValue({ id: 'move-out-1' }) },
      inspectionComparison: { findFirst: jest.fn().mockResolvedValue(comparison) },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    },
  };
}

describe('sharing a comparison report', () => {
  /**
   * The document says which areas carry new damage, and that is the basis for
   * money coming out of a deposit. A draft is the deterministic pass before
   * anybody has checked it.
   */
  it('refuses to share a comparison nobody has approved', async () => {
    const { prisma } = createPrisma({ status: 'DRAFT' });
    const service = new ReportShareService(prisma as never, {} as never);

    await expect(
      service.createShare(user, 'move-out-1', undefined, 'COMPARISON' as never),
    ).rejects.toMatchObject({ status: 409, code: 'COMPARISON_NOT_APPROVED' });
  });

  it('refuses when no comparison has been generated', async () => {
    const { prisma } = createPrisma(null);
    const service = new ReportShareService(prisma as never, {} as never);

    await expect(
      service.createShare(user, 'move-out-1', undefined, 'COMPARISON' as never),
    ).rejects.toMatchObject({ status: 404, code: 'COMPARISON_NOT_FOUND' });
  });

  it('issues a comparison link once it is approved', async () => {
    const { prisma, created } = createPrisma({ status: 'APPROVED' });
    const service = new ReportShareService(prisma as never, {} as never);

    await service.createShare(user, 'move-out-1', undefined, 'COMPARISON' as never);

    expect(created.data).toMatchObject({ kind: 'COMPARISON', inspectionId: 'move-out-1' });
  });

  /**
   * An inspection report and a comparison are different material. A link should
   * serve what it was created for, so the wrong kind reads as absent rather than
   * quietly handing over the other document.
   */
  it('will not serve a comparison through an inspection-report token', async () => {
    const prisma = {
      inspectionReportShare: {
        findUnique: jest.fn().mockResolvedValue({
          inspectionId: 'move-out-1',
          organizationId: user.organizationId,
          kind: 'INSPECTION',
          ...live,
          createdBy: { displayName: 'Operations Team' },
        }),
      },
    };
    const service = new ReportShareService(prisma as never, {} as never);

    await expect(service.publicComparisonReport('a-token')).rejects.toMatchObject({
      status: 404,
      code: 'REPORT_NOT_AVAILABLE',
    });
  });

  /**
   * A comparison link legitimately needs photographs from both inspections, so
   * the scope widens to the pair -- and no further.
   */
  it('serves photographs from either inspection of a comparison', async () => {
    const prisma = {
      inspectionReportShare: {
        findUnique: jest.fn().mockResolvedValue({
          inspectionId: 'move-out-1',
          organizationId: user.organizationId,
          kind: 'COMPARISON',
          ...live,
          createdBy: { displayName: 'Operations Team' },
        }),
      },
      inspectionComparison: {
        findFirst: jest.fn().mockResolvedValue({
          moveInInspectionId: 'move-in-1',
          moveOutInspectionId: 'move-out-1',
        }),
      },
      inspectionPhoto: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'photo-1', storageKey: 'key-1', mimeType: 'image/jpeg' }),
      },
    };
    const storage = { get: jest.fn().mockResolvedValue(Buffer.from('jpeg-bytes')) };
    const service = new ReportShareService(
      prisma as never,
      {} as never,
      undefined,
      storage as never,
    );

    await service.publicPhoto('a-token', 'photo-1');

    expect(prisma.inspectionPhoto.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'photo-1',
          inspectionId: { in: ['move-in-1', 'move-out-1'] },
        }),
      }),
    );
  });
});
