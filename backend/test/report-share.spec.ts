import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { ReportShareService } from '../src/admin/report-share.service';

const admin: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000002',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'System Admin',
  roles: [UserRole.SYSTEM_ADMIN],
  mustChangePassword: false,
};

describe('inspection report shares', () => {
  it('creates an org-scoped share with an unguessable token and audit trail', async () => {
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
      inspection: { findFirst: jest.fn().mockResolvedValue({ id: 'inspection-1' }) },
      $transaction: jest.fn(async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const service = new ReportShareService(prisma as never);

    const share = await service.createShare(admin, 'inspection-1', 'Owner@Example.com ');

    expect(prisma.inspection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inspection-1', organizationId: admin.organizationId },
      }),
    );
    expect(share.token.length).toBeGreaterThanOrEqual(40);
    expect(share.sharePath).toBe(`/report/${share.token}`);
    expect(share.recipientEmail).toBe('owner@example.com');
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'REPORT_SHARE_CREATED' }),
      }),
    );
  });

  it('rejects share creation for inspections outside the organization', async () => {
    const prisma = {
      inspection: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(),
    };
    const service = new ReportShareService(prisma as never);

    await expect(service.createShare(admin, 'foreign-inspection')).rejects.toMatchObject({
      status: 404,
      code: 'INSPECTION_NOT_FOUND',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses public reports for revoked and expired tokens', async () => {
    const revoked = {
      inspectionId: 'inspection-1',
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: new Date(),
    };
    const expired = {
      inspectionId: 'inspection-1',
      expiresAt: new Date(Date.now() - 1_000),
      revokedAt: null,
    };
    const prisma = {
      inspectionReportShare: {
        findUnique: jest.fn().mockResolvedValueOnce(revoked).mockResolvedValueOnce(expired),
      },
      inspection: { findUnique: jest.fn() },
    };
    const service = new ReportShareService(prisma as never);

    await expect(service.publicReport('revoked-token')).rejects.toMatchObject({
      code: 'REPORT_NOT_AVAILABLE',
    });
    await expect(service.publicReport('expired-token')).rejects.toMatchObject({
      code: 'REPORT_NOT_AVAILABLE',
    });
    expect(prisma.inspection.findUnique).not.toHaveBeenCalled();
  });

  it('builds the public report from approved findings only, without internal fields', async () => {
    const prisma = {
      inspectionReportShare: {
        findUnique: jest.fn().mockResolvedValue({
          inspectionId: 'inspection-1',
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: null,
        }),
      },
      inspection: {
        findUnique: jest.fn().mockResolvedValue({
          inspectionType: 'MOVE_OUT',
          status: 'COMPLETED',
          scheduledAt: new Date('2026-07-20T15:00:00Z'),
          completedAt: new Date('2026-07-22T15:00:00Z'),
          propertywareBuilding: {
            name: 'Oak Ridge',
            addressLine1: '1458 Oak Ridge Dr',
            city: 'Austin',
            state: 'TX',
            postalCode: '78701',
          },
          areas: [
            {
              id: 'area-1',
              completionStatus: 'COMPLETED',
              skipReason: null,
              completedAt: new Date(),
              propertyArea: { name: 'Kitchen', floor: { name: 'Ground Floor' } },
            },
          ],
          findings: [
            {
              id: 'finding-1',
              title: 'Countertop burn mark',
              description: 'New burn mark near the stove.',
              category: 'DAMAGE',
              severity: 'MODERATE',
              comparisonResult: 'WORSENED',
              baselineCondition: 'No damage documented at move-in.',
              propertyArea: { name: 'Kitchen' },
            },
          ],
        }),
      },
    };
    const service = new ReportShareService(prisma as never);

    const report = await service.publicReport('valid-token');

    const findingsQuery = prisma.inspection.findUnique.mock.calls[0][0] as {
      select: { findings: { where: { reviewStatus: string } } };
    };
    expect(findingsQuery.select.findings.where).toEqual({ reviewStatus: 'APPROVED' });
    expect(report.property.addressLine1).toBe('1458 Oak Ridge Dr');
    expect(report.rooms).toHaveLength(1);
    expect(report.findings).toHaveLength(1);
    expect(JSON.stringify(report)).not.toMatch(/internalNotes|technician|organizationId/);
  });

  it('revoking twice is idempotent', async () => {
    const share = {
      id: 'share-1',
      inspectionId: 'inspection-1',
      token: 'token',
      recipientEmail: null,
      expiresAt: new Date(),
      revokedAt: new Date(),
      createdAt: new Date(),
    };
    const prisma = {
      inspectionReportShare: { findFirst: jest.fn().mockResolvedValue(share) },
      $transaction: jest.fn(),
    };
    const service = new ReportShareService(prisma as never);

    await expect(service.revokeShare(admin, 'share-1')).resolves.toMatchObject({
      id: 'share-1',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
