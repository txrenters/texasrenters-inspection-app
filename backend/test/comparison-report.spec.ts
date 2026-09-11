import { UserRole } from '@texasrenters/shared';

import { ComparisonReportService } from '../src/admin/comparison-report.service';
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

function areaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ac-1',
    areaName: 'Kitchen',
    floorName: '1',
    classification: 'NEW_DAMAGE',
    originalClassification: null,
    overrideReason: null,
    matchMethod: 'LOCAL_AREA_ID',
    matchConfidence: 1,
    requiresReview: true,
    summary: 'New damage flagged at move-out.',
    moveInPropertyAreaId: 'pa-kitchen',
    moveOutPropertyAreaId: 'pa-kitchen',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** An inspection as `loadSide` selects it. */
function inspectionRow(id: string, type: string, propertyAreaIds: string[], photoId?: string) {
  return {
    id,
    inspectionType: type,
    status: 'COMPLETED',
    scheduledAt: new Date('2026-01-05T00:00:00.000Z'),
    completedAt: new Date('2026-01-06T00:00:00.000Z'),
    assignments: [{ technician: { displayName: 'Moses' } }],
    propertywareUnit: { name: 'Unit A' },
    propertywareBuilding: {
      name: 'Lynbriar',
      addressLine1: '25303 Lynbriar Ln',
      city: 'Katy',
      state: 'TX',
      postalCode: '77494',
    },
    areas: propertyAreaIds.map((propertyAreaId, index) => ({
      id: `${id}-area-${index}`,
      propertyAreaId,
      completionStatus: 'COMPLETED',
      skipReason: null,
      propertyArea: { name: 'Kitchen', floor: { name: '1' } },
      checklistResponses: [
        {
          isClean: false,
          isUndamaged: true,
          isWorking: null,
          comment: 'Grease on the hob',
          checklistItem: { id: 'ci-1', label: 'Hob', keywords: ['hob'] },
        },
      ],
      photos: photoId
        ? [
            {
              id: photoId,
              label: null,
              notes: null,
              capturedAt: new Date('2026-01-06T10:00:00.000Z'),
              width: 800,
              height: 600,
              checklistItem: { label: 'Hob' },
            },
          ]
        : [],
    })),
    findings: [],
  };
}

function prismaDouble(opts: {
  comparison: Record<string, unknown> | null;
  moveIn: ReturnType<typeof inspectionRow>;
  moveOut: ReturnType<typeof inspectionRow>;
}) {
  const inspectionFindUnique = jest.fn(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === opts.moveIn.id ? opts.moveIn : opts.moveOut),
  );
  return {
    inspectionComparison: { findFirst: jest.fn().mockResolvedValue(opts.comparison) },
    inspection: { findUnique: inspectionFindUnique },
    userProfile: { findUnique: jest.fn().mockResolvedValue({ displayName: 'Reviewer' }) },
  };
}

const comparison = {
  id: 'cmp-1',
  status: 'DRAFT',
  version: 5,
  overallCondition: 'NEW_DAMAGE',
  requiresReviewCount: 1,
  summary: 'Compared 1 area.',
  generatedAt: new Date('2026-09-11T00:00:00.000Z'),
  reviewedById: null,
  reviewedAt: null,
  moveInInspectionId: 'move-in-1',
  moveOutInspectionId: 'move-out-1',
  areaComparisons: [areaRow()],
};

describe('comparison report', () => {
  it('refuses when no comparison has been generated', async () => {
    const prisma = prismaDouble({
      comparison: null,
      moveIn: inspectionRow('move-in-1', 'MOVE_IN', ['pa-kitchen']),
      moveOut: inspectionRow('move-out-1', 'MOVE_OUT', ['pa-kitchen']),
    });
    const service = new ComparisonReportService(prisma as never);

    await expect(service.report(user, 'move-out-1')).rejects.toMatchObject({
      status: 404,
      code: 'COMPARISON_NOT_FOUND',
    });
  });

  /**
   * The pairing is read from `InspectionAreaComparison`, never recomputed. A
   * second opinion here could disagree with the page the reviewer approved.
   */
  it('pairs each side from the stored comparison row', async () => {
    const prisma = prismaDouble({
      comparison,
      moveIn: inspectionRow('move-in-1', 'MOVE_IN', ['pa-kitchen']),
      moveOut: inspectionRow('move-out-1', 'MOVE_OUT', ['pa-kitchen'], 'photo-9'),
    });
    const service = new ComparisonReportService(prisma as never);

    const report = await service.report(user, 'move-out-1');

    expect(report.areas).toHaveLength(1);
    expect(report.areas[0]).toMatchObject({
      areaName: 'Kitchen',
      classification: 'NEW_DAMAGE',
      matchMethod: 'LOCAL_AREA_ID',
    });
    expect(report.areas[0]?.moveIn?.roomId).toBe('move-in-1-area-0');
    expect(report.areas[0]?.moveOut?.roomId).toBe('move-out-1-area-0');
    // Move-in header carries the date and who carried it out.
    expect(report.moveIn).toMatchObject({ type: 'MOVE_IN', inspector: 'Moses' });
    expect(report.moveOut).toMatchObject({ type: 'MOVE_OUT', inspector: 'Moses' });
  });

  /**
   * An area documented at move-in and never revisited is the whole point of the
   * document, so it keeps its row with one side empty rather than disappearing.
   */
  it('keeps a row whose other side has no area', async () => {
    const prisma = prismaDouble({
      comparison: {
        ...comparison,
        areaComparisons: [
          areaRow({ areaName: 'Garage/Carport', moveOutPropertyAreaId: null }),
        ],
      },
      moveIn: inspectionRow('move-in-1', 'MOVE_IN', ['pa-kitchen']),
      moveOut: inspectionRow('move-out-1', 'MOVE_OUT', []),
    });
    const service = new ComparisonReportService(prisma as never);

    const report = await service.report(user, 'move-out-1');

    expect(report.areas).toHaveLength(1);
    expect(report.areas[0]?.moveIn).not.toBeNull();
    expect(report.areas[0]?.moveOut).toBeNull();
  });

  it("surfaces a reviewer's override alongside what it replaced", async () => {
    const prisma = prismaDouble({
      comparison: {
        ...comparison,
        areaComparisons: [
          areaRow({
            classification: 'UNCHANGED',
            originalClassification: 'NEW_DAMAGE',
            overrideReason: 'Pre-existing, see lease addendum',
          }),
        ],
      },
      moveIn: inspectionRow('move-in-1', 'MOVE_IN', ['pa-kitchen']),
      moveOut: inspectionRow('move-out-1', 'MOVE_OUT', ['pa-kitchen']),
    });
    const service = new ComparisonReportService(prisma as never);

    const report = await service.report(user, 'move-out-1');

    expect(report.areas[0]).toMatchObject({
      classification: 'UNCHANGED',
      originalClassification: 'NEW_DAMAGE',
      overrideReason: 'Pre-existing, see lease addendum',
    });
  });

  /**
   * Photographs are served from the authenticated console route. This is the one
   * field a share-link version of the document would change.
   */
  it('points photographs at the authenticated admin route', async () => {
    const prisma = prismaDouble({
      comparison,
      moveIn: inspectionRow('move-in-1', 'MOVE_IN', ['pa-kitchen']),
      moveOut: inspectionRow('move-out-1', 'MOVE_OUT', ['pa-kitchen'], 'photo-9'),
    });
    const service = new ComparisonReportService(prisma as never);

    const report = await service.report(user, 'move-out-1');

    expect(report.areas[0]?.moveOut?.photos[0]).toMatchObject({
      id: 'photo-9',
      contentPath: '/api/v1/admin/photos/photo-9/content',
      // Captioned by the checklist item it evidences, as the printed report is.
      label: 'Hob',
    });
  });

  it('scopes the lookup to the caller organization', async () => {
    const prisma = prismaDouble({
      comparison,
      moveIn: inspectionRow('move-in-1', 'MOVE_IN', ['pa-kitchen']),
      moveOut: inspectionRow('move-out-1', 'MOVE_OUT', ['pa-kitchen']),
    });
    const service = new ComparisonReportService(prisma as never);

    await service.report(user, 'move-out-1');

    expect(prisma.inspectionComparison.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { moveOutInspectionId: 'move-out-1', organizationId: user.organizationId },
      }),
    );
  });
});
