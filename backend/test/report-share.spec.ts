import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { ReportShareService } from '../src/admin/report-share.service';

const admin: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000002',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'System Admin',
  roles: [UserRole.SYSTEM_ADMIN],
  permissions: [],
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
              propertyAreaId: 'property-area-1',
              completionStatus: 'COMPLETED',
              skipReason: null,
              completedAt: new Date(),
              propertyArea: { name: 'Kitchen', floor: { name: 'Ground Floor' } },
              photos: [
                {
                  id: 'photo-1',
                  label: 'Countertop',
                  notes: null,
                  capturedAt: new Date('2026-07-22T16:12:00Z'),
                  width: 1600,
                  height: 1200,
                },
              ],
            },
          ],
          findings: [
            {
              id: 'finding-1',
              propertyAreaId: 'property-area-1',
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
    // Findings resolve to the per-inspection room so the view model can group them.
    expect(report.findings[0].roomId).toBe('area-1');
    expect(report.photos).toHaveLength(1);
    expect(report.photos[0].contentPath).toBe('/api/v1/reports/valid-token/photos/photo-1');
    expect(JSON.stringify(report)).not.toMatch(/internalNotes|technician|organizationId/);
  });

  it('only exposes area overviews and photos belonging to an approved finding', async () => {
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
          scheduledAt: new Date(),
          completedAt: new Date(),
          propertywareBuilding: null,
          propertywareUnit: null,
          areas: [],
          findings: [],
        }),
      },
    };
    const service = new ReportShareService(prisma as never);

    await service.publicReport('valid-token');

    const query = prisma.inspection.findUnique.mock.calls[0][0] as {
      select: { areas: { select: { photos: { where: unknown } } } };
    };
    // Both clauses matter: `findingId: null` alone would re-expose a detail
    // photo whose rejected finding was deleted (relation is onDelete: SetNull).
    expect(query.select.areas.select.photos.where).toEqual({
      OR: [
        { captureType: 'AREA_OVERVIEW', findingId: null },
        { finding: { reviewStatus: 'APPROVED' } },
      ],
    });
  });

  it('scopes shared photo reads to the share inspection and re-applies the visibility rule', async () => {
    const prisma = {
      inspectionReportShare: {
        findUnique: jest.fn().mockResolvedValue({
          inspectionId: 'inspection-1',
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: null,
        }),
      },
      inspectionPhoto: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'photo-1', storageKey: 'key-1', mimeType: 'image/jpeg' }),
      },
    };
    const storage = { get: jest.fn().mockResolvedValue(Buffer.from('jpeg-bytes')) };
    const service = new ReportShareService(prisma as never, undefined, storage as never);

    const photo = await service.publicPhoto('valid-token', 'photo-1');

    expect(photo.mimeType).toBe('image/jpeg');
    expect(prisma.inspectionPhoto.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'photo-1',
          inspectionId: 'inspection-1',
          AND: {
            OR: [
              { captureType: 'AREA_OVERVIEW', findingId: null },
              { finding: { reviewStatus: 'APPROVED' } },
            ],
          },
        },
      }),
    );
  });

  it('refuses a photo that belongs to another inspection', async () => {
    const prisma = {
      inspectionReportShare: {
        findUnique: jest.fn().mockResolvedValue({
          inspectionId: 'inspection-1',
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: null,
        }),
      },
      // The scoped query matches nothing for a foreign photo id.
      inspectionPhoto: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const storage = { get: jest.fn() };
    const service = new ReportShareService(prisma as never, undefined, storage as never);

    await expect(service.publicPhoto('valid-token', 'foreign-photo')).rejects.toMatchObject({
      status: 404,
      code: 'REPORT_PHOTO_NOT_FOUND',
    });
    expect(storage.get).not.toHaveBeenCalled();
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
