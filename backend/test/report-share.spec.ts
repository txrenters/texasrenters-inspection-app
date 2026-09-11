import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { ReportShareService } from '../src/admin/report-share.service';

/**
 * The comparison-report builder, which none of these cases reaches. It is a
 * constructor dependency because a comparison share serves a document this
 * service does not itself assemble; the inspection-report paths below never
 * call it.
 */
const comparisonReports = { reportForShare: jest.fn() };

const admin: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000002',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'System Admin',
  roles: [UserRole.SYSTEM_ADMIN],
  permissions: [],
  mustChangePassword: false,
  // Added with `principalType`; these fixtures are people, not integrations.
  principalType: 'USER',
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
    const service = new ReportShareService(prisma as never, comparisonReports as never);

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
    const service = new ReportShareService(prisma as never, comparisonReports as never);

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
    const service = new ReportShareService(prisma as never, comparisonReports as never);

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
          // Whoever issued the link; the report names the office before the field.
          createdBy: { displayName: 'Operations Team' },
        }),
      },
      inspection: {
        findUnique: jest.fn().mockResolvedValue({
          inspectionType: 'MOVE_OUT',
          assignments: [{ technician: { displayName: 'Lovely Mae' } }],
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
              // A partial assessment: Working was never scored, and the report
              // has to carry that through as null rather than false.
              checklistResponses: [
                {
                  isClean: false,
                  isUndamaged: true,
                  isWorking: null,
                  comment: 'scratches on door',
                  checklistItem: { id: 'item-1', label: 'Doors and locks' },
                },
              ],
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
    const service = new ReportShareService(prisma as never, comparisonReports as never);

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
    // The rule the printed report depends on: an unassessed axis stays null.
    // Coercing it to false would publish a defect the technician never
    // observed, on a document a tenant may be shown.
    // The office first, then the field — the order the printed report uses.
    // Deduplicated, so an administrator who is also the assignee is not printed
    // twice.
    expect(report.inspection.inspector).toBe('Operations Team / Lovely Mae');
    expect(report.rooms[0].checklist).toEqual([
      {
        id: 'item-1',
        label: 'Doors and locks',
        isClean: false,
        isUndamaged: true,
        isWorking: null,
        comment: 'scratches on door',
      },
    ]);
    expect(JSON.stringify(report)).not.toMatch(/internalNotes|technician|organizationId/);
  });

  it('withholds only the photos of a finding nobody approved', async () => {
    const prisma = {
      inspectionReportShare: {
        findUnique: jest.fn().mockResolvedValue({
          inspectionId: 'inspection-1',
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: null,
          // Whoever issued the link; the report names the office before the field.
          createdBy: { displayName: 'Operations Team' },
        }),
      },
      inspection: {
        findUnique: jest.fn().mockResolvedValue({
          inspectionType: 'MOVE_OUT',
          // Unassigned: the report must not claim an inspector it lacks.
          assignments: [],
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
    const service = new ReportShareService(prisma as never, comparisonReports as never);

    await service.publicReport('valid-token');

    const query = prisma.inspection.findUnique.mock.calls[0][0] as {
      select: { areas: { select: { photos: { where: unknown } } } };
    };
    /**
     * What must not leak is unreviewed AI output — a photograph attached to a
     * finding nobody has approved. A photograph with no finding on it is the
     * technician's own record and carries no such claim.
     *
     * Deliberately no `captureType` clause. Restricting to AREA_OVERVIEW read
     * as a tighter rule and was really a bug: guided capture files its shots as
     * FINDING_CONTEXT, so a two-room inspection with twelve photographs
     * published two of them and the report looked empty.
     */
    expect(query.select.areas.select.photos.where).toEqual({
      OR: [{ findingId: null }, { finding: { reviewStatus: 'APPROVED' } }],
    });
  });

  it('scopes shared photo reads to the share inspection and re-applies the visibility rule', async () => {
    const prisma = {
      inspectionReportShare: {
        findUnique: jest.fn().mockResolvedValue({
          inspectionId: 'inspection-1',
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: null,
          // Whoever issued the link; the report names the office before the field.
          createdBy: { displayName: 'Operations Team' },
        }),
      },
      inspectionPhoto: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'photo-1', storageKey: 'key-1', mimeType: 'image/jpeg' }),
      },
    };
    const storage = { get: jest.fn().mockResolvedValue(Buffer.from('jpeg-bytes')) };
    const service = new ReportShareService(prisma as never, comparisonReports as never, undefined, storage as never);

    const photo = await service.publicPhoto('valid-token', 'photo-1');

    expect(photo.mimeType).toBe('image/jpeg');
    expect(prisma.inspectionPhoto.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'photo-1',
          // A list because a comparison link covers two inspections. An
          // inspection link still narrows to exactly one, which is the point:
          // the scope widened, it did not open.
          inspectionId: { in: ['inspection-1'] },
          AND: { OR: [{ findingId: null }, { finding: { reviewStatus: 'APPROVED' } }] },
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
          // Whoever issued the link; the report names the office before the field.
          createdBy: { displayName: 'Operations Team' },
        }),
      },
      // The scoped query matches nothing for a foreign photo id.
      inspectionPhoto: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const storage = { get: jest.fn() };
    const service = new ReportShareService(prisma as never, comparisonReports as never, undefined, storage as never);

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
    const service = new ReportShareService(prisma as never, comparisonReports as never);

    await expect(service.revokeShare(admin, 'share-1')).resolves.toMatchObject({
      id: 'share-1',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
