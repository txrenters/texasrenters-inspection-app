import { InspectionStatus } from '@prisma/client';
import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { TechnicianService } from '../src/technician/technician.service';

const technician: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-technician',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Field Technician',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
};

function mediaProcessingDouble() {
  return { queue: jest.fn(), advanceInspection: jest.fn().mockResolvedValue(undefined) } as never;
}

describe('technician mobile data boundary', () => {
  it('builds the dashboard from bounded database summaries instead of a 100-row client filter', async () => {
    const prisma = {
      inspection: {
        groupBy: jest.fn().mockResolvedValue([
          { status: InspectionStatus.IN_PROGRESS, _count: { _all: 2 } },
          { status: InspectionStatus.COMPLETED, _count: { _all: 4 } },
        ]),
        count: jest.fn().mockResolvedValue(3),
        findMany: jest.fn().mockResolvedValue([]),
      },
      inspectionMedia: { count: jest.fn().mockResolvedValue(1) },
    };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      {} as never,
      mediaProcessingDouble(),
    );

    await expect(service.dashboard(technician)).resolves.toMatchObject({
      today: 3,
      inProgress: 2,
      completed: 4,
      pendingUploads: 1,
      assignments: [],
      recent: [],
    });
    expect(prisma.inspection.findMany).toHaveBeenCalledTimes(2);
    for (const [request] of prisma.inspection.findMany.mock.calls) {
      expect(request.take).toBeLessThanOrEqual(25);
      expect(request.select).toEqual(expect.any(Object));
    }
  });

  it('puts overdue and next-week work in the queue, not only today', async () => {
    // The home screen renders `assignments` under a heading called "Upcoming".
    // It was previously filtered to `scheduledAt` within today, so an
    // inspection created for tomorrow was invisible the moment it was saved,
    // and nothing overdue ever appeared either.
    const prisma = {
      inspection: {
        groupBy: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      inspectionMedia: { count: jest.fn().mockResolvedValue(0) },
    };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      {} as never,
      mediaProcessingDouble(),
    );

    await service.dashboard(technician);

    const [queueRequest] = prisma.inspection.findMany.mock.calls[0];
    // No lower bound: an inspection scheduled last week that is still open has
    // to keep appearing until it is dealt with.
    expect(queueRequest.where.scheduledAt.gte).toBeUndefined();
    expect(queueRequest.where.scheduledAt.lt.getTime()).toBeGreaterThan(Date.now());
    // Only work that still needs the technician — review states belong to the
    // administrator, not the field queue.
    expect(queueRequest.where.status).toEqual({
      in: [InspectionStatus.SCHEDULED, InspectionStatus.IN_PROGRESS],
    });
    expect(queueRequest.orderBy).toEqual({ scheduledAt: 'asc' });

    // The "today" tile still counts today alone.
    const [countRequest] = prisma.inspection.count.mock.calls[0];
    expect(countRequest.where.scheduledAt.gte).toEqual(expect.any(Date));
    expect(countRequest.where.scheduledAt.lt).toEqual(expect.any(Date));
  });

  it('returns an empty first-time workspace and scopes inspection reads to current assignments', async () => {
    const prisma = {
      inspection: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      {} as never,
      mediaProcessingDouble(),
    );

    await expect(service.inspections(technician)).resolves.toEqual(
      expect.objectContaining({ items: [], total: 0 }),
    );
    expect(prisma.inspection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: technician.organizationId,
          assignments: {
            some: { technicianId: technician.id, isCurrent: true },
          },
        }),
      }),
    );
  });

  it('treats an unassigned inspection as missing', async () => {
    const prisma = {
      inspection: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      {} as never,
      mediaProcessingDouble(),
    );

    await expect(service.inspection(technician, 'inspection-other')).rejects.toMatchObject({
      status: 404,
      code: 'ASSIGNED_INSPECTION_NOT_FOUND',
    });
    expect(prisma.inspection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'inspection-other',
          assignments: {
            some: { technicianId: technician.id, isCurrent: true },
          },
        }),
      }),
    );
  });

  it('returns the assigned inspection screen context from one scoped read', async () => {
    const scheduledAt = new Date('2026-07-21T10:00:00.000Z');
    const prisma = {
      inspection: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'inspection-1',
          inspectionType: 'MOVE_OUT',
          scheduledAt,
          status: InspectionStatus.SCHEDULED,
          priority: 'STANDARD',
          internalNotes: null,
          propertywareBuilding: {
            id: 'building-1',
            externalId: 'external-building',
            externalPortfolioId: 'external-portfolio',
            name: 'Building',
            addressLine1: '1 Main St',
            city: 'Austin',
            state: 'TX',
            postalCode: '78701',
            units: [{ bedrooms: 2, bathrooms: 1 }],
          },
          areas: [],
          _count: { findings: 0 },
        }),
      },
    };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      {} as never,
      mediaProcessingDouble(),
    );

    await expect(service.inspectionContext(technician, 'inspection-1')).resolves.toMatchObject({
      inspection: { id: 'inspection-1', roomIds: [] },
      property: { id: 'building-1', bedrooms: 2, bathrooms: 1 },
      rooms: [],
      pendingReviewCount: 0,
    });
    expect(prisma.inspection.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.inspection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'inspection-1',
          organizationId: technician.organizationId,
          assignments: { some: { technicianId: technician.id, isCurrent: true } },
        }),
        select: expect.objectContaining({ _count: expect.any(Object), areas: expect.any(Object) }),
      }),
    );
  });

  it('paginates findings and applies review status in the database query', async () => {
    const finding = {
      id: 'finding-1',
      inspectionId: 'inspection-1',
      propertyAreaId: 'area-1',
      title: 'Wall damage',
      category: 'DAMAGE',
      severity: 'MODERATE',
      comparisonResult: 'WORSENED',
      confidence: 0.8,
      videoTimestampStart: null,
      videoTimestampEnd: null,
      baselineCondition: null,
      description: 'A new mark is visible.',
      recommendedReview: true,
      reviewStatus: 'PENDING_REVIEW',
      propertyArea: { name: 'Living Room' },
      reviews: [],
    };
    const prisma = {
      inspection: { findFirst: jest.fn().mockResolvedValue({ id: 'inspection-1' }) },
      inspectionFinding: {
        findMany: jest.fn().mockResolvedValue([finding]),
        count: jest.fn().mockResolvedValue(26),
      },
    };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      {} as never,
      mediaProcessingDouble(),
    );

    await expect(
      service.findings(technician, 'inspection-1', {
        page: 2,
        pageSize: 25,
        reviewStatus: 'PENDING_REVIEW',
      }),
    ).resolves.toMatchObject({ page: 2, pageSize: 25, total: 26, totalPages: 2 });
    expect(prisma.inspectionFinding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { inspectionId: 'inspection-1', reviewStatus: 'PENDING_REVIEW' },
        skip: 25,
        take: 25,
        select: expect.objectContaining({ propertyArea: { select: { name: true } } }),
      }),
    );
  });

  it('does not allow a room to complete without confirmed uploaded video', async () => {
    const prisma = {
      inspectionArea: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'room-1',
          inspectionId: 'inspection-1',
          propertyAreaId: 'area-1',
          completionStatus: 'PENDING',
          propertyArea: { baselineConditions: [] },
          media: [],
        }),
        update: jest.fn(),
      },
    };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      {} as never,
      mediaProcessingDouble(),
    );

    await expect(service.completeRoom(technician, 'room-1')).rejects.toMatchObject({
      status: 409,
      code: 'ROOM_VIDEO_REQUIRED',
    });
    expect(prisma.inspectionArea.update).not.toHaveBeenCalled();
  });

  it('maps only active assignment statuses into the technician contract', async () => {
    const scheduledAt = new Date('2026-07-21T10:00:00.000Z');
    const prisma = {
      inspection: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'inspection-1',
            inspectionType: 'MOVE_OUT',
            scheduledAt,
            status: InspectionStatus.SCHEDULED,
            priority: 'STANDARD',
            internalNotes: null,
            propertywareBuilding: {
              id: 'building-1',
              name: 'Building',
              addressLine1: '1 Main St',
              city: 'Austin',
              state: 'TX',
              postalCode: '78701',
            },
            areas: [],
          },
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      {} as never,
      mediaProcessingDouble(),
    );

    await expect(service.inspections(technician)).resolves.toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            id: 'inspection-1',
            propertyId: 'building-1',
            assignedUserId: technician.id,
            status: 'SCHEDULED',
            scheduledAt: scheduledAt.toISOString(),
          }),
        ],
      }),
    );
  });

  it('returns only the latest approved plan for an assigned property', async () => {
    const createdAt = new Date('2026-07-21T10:00:00.000Z');
    const prisma = {
      propertywareBuilding: { findFirst: jest.fn().mockResolvedValue({ id: 'building-1' }) },
      propertyFloorPlan: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'plan-1',
          fileName: 'approved.png',
          mimeType: 'image/png',
          sizeBytes: 100,
          status: 'APPROVED',
          createdAt,
        }),
      },
    };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      {} as never,
      mediaProcessingDouble(),
    );

    await expect(service.floorPlan(technician, 'building-1')).resolves.toEqual({
      id: 'plan-1',
      fileName: 'approved.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      status: 'APPROVED',
      createdAt: createdAt.toISOString(),
      contentPath: '/api/v1/technician/floor-plans/plan-1/content',
    });
    expect(prisma.propertyFloorPlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { propertyId: 'building-1', status: 'APPROVED' } }),
    );
  });

  it('stores a room video once, replaces earlier recordings, and completes the room after upload confirmation', async () => {
    const createdAt = new Date('2026-07-22T12:00:00.000Z');
    const created = {
      id: 'media-2',
      inspectionId: 'inspection-1',
      inspectionAreaId: 'area-1',
      durationSeconds: 42,
      uploadStatus: 'UPLOADED',
      processingStatus: 'PENDING',
      createdAt,
    };
    const tx = {
      inspectionMedia: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue(created),
      },
      inspectionArea: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      inspectionArea: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'area-1',
          inspectionId: 'inspection-1',
          completionStatus: 'PENDING',
          inspection: {
            organizationId: technician.organizationId,
            propertyId: null,
            propertywareBuilding: { addressLine1: '1 Main St' },
          },
          propertyArea: { name: 'Living Room' },
          media: [
            // Pre-migration row: storageKey was backfilled from providerMediaId.
            {
              id: 'media-1',
              providerMediaId: 'local-old-key',
              storageKey: 'local-old-key',
              recordingType: 'PRIMARY_AREA',
            },
          ],
        }),
      },
      $transaction: jest.fn(async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const storage = {
      putFromFile: jest.fn().mockResolvedValue(undefined),
      providerName: () => 'local',
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      storage as never,
      mediaProcessingDouble(),
    );

    await expect(
      service.uploadRoomMedia(
        technician,
        'area-1',
        { idempotencyKey: 'local-media-abc12345', durationSeconds: 42 },
        { path: 'C:/tmp/upload.mp4', mimetype: 'video/mp4', size: 100, originalname: 'v.mp4' },
      ),
    ).resolves.toMatchObject({
      id: 'media-2',
      roomId: 'area-1',
      roomName: 'Living Room',
      status: 'COMPLETED',
      progress: 1,
    });
    // The object key is tenant-scoped and independent of providerMediaId, so the
    // storage backend can change without rewriting media identity.
    expect(storage.putFromFile).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^${technician.organizationId}/inspection-1/area-1/videos/[0-9a-f-]{36}\\.mp4$`),
      ),
      'C:/tmp/upload.mp4',
      'video/mp4',
    );
    expect(tx.inspectionMedia.deleteMany).toHaveBeenCalledWith({
      where: { inspectionAreaId: 'area-1', recordingType: 'PRIMARY_AREA' },
    });
    expect(tx.inspectionArea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          completionStatus: 'COMPLETED',
          completedAt: expect.any(Date),
        }),
      }),
    );
    expect(storage.delete).toHaveBeenCalledWith('local-old-key');
  });

  it('returns the stored media unchanged when the same idempotency key is re-sent', async () => {
    const record = {
      id: 'media-1',
      inspectionId: 'inspection-1',
      inspectionAreaId: 'area-1',
      durationSeconds: 42,
      uploadStatus: 'UPLOADED',
      processingStatus: 'PENDING',
      createdAt: new Date(),
    };
    const prisma = {
      inspectionArea: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'area-1',
          inspectionId: 'inspection-1',
          completionStatus: 'RECORDED',
          inspection: {
            organizationId: technician.organizationId,
            propertyId: null,
            propertywareBuilding: null,
          },
          propertyArea: { name: 'Living Room' },
          media: [{ id: 'media-1', providerMediaId: 'local-local-media-abc12345' }],
        }),
      },
      inspectionMedia: { findUniqueOrThrow: jest.fn().mockResolvedValue(record) },
      $transaction: jest.fn(),
    };
    const storage = { putFromFile: jest.fn(), delete: jest.fn(), providerName: () => 'local' };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      storage as never,
      mediaProcessingDouble(),
    );

    await expect(
      service.uploadRoomMedia(
        technician,
        'area-1',
        { idempotencyKey: 'local-media-abc12345', durationSeconds: 42 },
        { path: 'C:/tmp/upload.mp4', mimetype: 'video/mp4', size: 100, originalname: 'v.mp4' },
      ),
    ).resolves.toMatchObject({ id: 'media-1', status: 'COMPLETED' });
    expect(storage.putFromFile).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects new videos for completed rooms and non-video uploads', async () => {
    const prisma = {
      inspectionArea: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'area-1',
          inspectionId: 'inspection-1',
          completionStatus: 'COMPLETED',
          inspection: {
            organizationId: technician.organizationId,
            propertyId: null,
            propertywareBuilding: null,
          },
          propertyArea: { name: 'Living Room' },
          media: [],
        }),
      },
    };
    const storage = { putFromFile: jest.fn(), delete: jest.fn(), providerName: () => 'local' };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      storage as never,
      mediaProcessingDouble(),
    );

    await expect(
      service.uploadRoomMedia(
        technician,
        'area-1',
        { idempotencyKey: 'local-media-abc12345', durationSeconds: 42 },
        { path: 'C:/tmp/upload.mp4', mimetype: 'video/mp4', size: 100, originalname: 'v.mp4' },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'ROOM_ALREADY_COMPLETED' });
    await expect(
      service.uploadRoomMedia(
        technician,
        'area-1',
        { idempotencyKey: 'local-media-abc12345', durationSeconds: 42 },
        {
          path: 'C:/tmp/upload.pdf',
          mimetype: 'application/pdf',
          size: 100,
          originalname: 'a.pdf',
        },
      ),
    ).rejects.toMatchObject({ status: 415, code: 'ROOM_VIDEO_TYPE_UNSUPPORTED' });
    expect(storage.putFromFile).not.toHaveBeenCalled();
  });

  it('stores an additional labeled video without replacing the primary or completing the room', async () => {
    const createdAt = new Date('2026-07-25T12:00:00.000Z');
    const created = {
      id: 'media-extra-1',
      inspectionId: 'inspection-1',
      inspectionAreaId: 'area-1',
      durationSeconds: 20,
      uploadStatus: 'UPLOADED',
      processingStatus: 'PENDING',
      recordingType: 'ADDITIONAL_ISSUE',
      label: 'Water stain under sink',
      createdAt,
    };
    const prisma = {
      inspectionArea: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'area-1',
          inspectionId: 'inspection-1',
          propertyAreaId: 'parea-1',
          inspection: {
            organizationId: technician.organizationId,
            propertyId: null,
            propertywareBuilding: { addressLine1: '1 Main St' },
          },
          propertyArea: { name: 'Kitchen' },
        }),
        update: jest.fn(),
      },
      inspectionMedia: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(created),
      },
    };
    const storage = {
      putFromFile: jest.fn().mockResolvedValue(undefined),
      providerName: () => 'local',
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      storage as never,
      mediaProcessingDouble(),
    );

    await expect(
      service.uploadAdditionalVideo(
        technician,
        'area-1',
        {
          idempotencyKey: 'extra-video-abc12345',
          durationSeconds: 20,
          label: 'Water stain under sink',
          category: 'PLUMBING',
        },
        { path: 'C:/tmp/extra.mp4', mimetype: 'video/mp4', size: 100, originalname: 'e.mp4' },
      ),
    ).resolves.toMatchObject({
      id: 'media-extra-1',
      roomId: 'area-1',
      recordingType: 'ADDITIONAL_ISSUE',
      label: 'Water stain under sink',
      status: 'COMPLETED',
    });
    expect(prisma.inspectionMedia.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recordingType: 'ADDITIONAL_ISSUE',
          label: 'Water stain under sink',
          category: 'PLUMBING',
        }),
      }),
    );
    // The primary walkthrough invariant is untouched: no room completion.
    expect(prisma.inspectionArea.update).not.toHaveBeenCalled();
  });

  it('rejects an additional video whose related finding is not in the area', async () => {
    const prisma = {
      inspectionArea: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'area-1',
          inspectionId: 'inspection-1',
          propertyAreaId: 'parea-1',
          inspection: {
            organizationId: technician.organizationId,
            propertyId: null,
            propertywareBuilding: null,
          },
          propertyArea: { name: 'Kitchen' },
        }),
      },
      inspectionMedia: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      inspectionFinding: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const storage = { putFromFile: jest.fn(), delete: jest.fn(), providerName: () => 'local' };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      storage as never,
      mediaProcessingDouble(),
    );

    await expect(
      service.uploadAdditionalVideo(
        technician,
        'area-1',
        {
          idempotencyKey: 'extra-video-abc12345',
          durationSeconds: 20,
          label: 'Damage clip',
          relatedFindingId: '00000000-0000-0000-0000-000000000000',
        },
        { path: 'C:/tmp/extra.mp4', mimetype: 'video/mp4', size: 100, originalname: 'e.mp4' },
      ),
    ).rejects.toMatchObject({ status: 422, code: 'FINDING_NOT_IN_AREA' });
    expect(storage.putFromFile).not.toHaveBeenCalled();
    expect(prisma.inspectionMedia.create).not.toHaveBeenCalled();
  });

  it('does not read plan bytes when the technician has no current property assignment', async () => {
    const prisma = {
      propertyFloorPlan: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'plan-1',
          propertyId: 'building-other',
          storageKey: 'private/plan.png',
          fileName: 'plan.png',
          mimeType: 'image/png',
        }),
      },
      propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const storage = { get: jest.fn() };
    const service = new TechnicianService(
      prisma as never,
      storage as never,
      {} as never,
      mediaProcessingDouble(),
    );

    await expect(service.floorPlanContent(technician, 'plan-1')).rejects.toMatchObject({
      status: 404,
      code: 'ASSIGNED_PROPERTY_NOT_FOUND',
    });
    expect(storage.get).not.toHaveBeenCalled();
  });
});
