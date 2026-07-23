import { rm } from 'node:fs/promises';

import { Inject, Injectable } from '@nestjs/common';
import {
  FloorPlanStatus,
  InspectionAreaCompletionStatus,
  InspectionStatus,
  InspectionType,
  MediaProcessingStatus,
  MediaUploadStatus,
} from '@prisma/client';
import type { FindingReviewStatus, Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { FloorPlanStorageService } from '../admin/floor-plan-storage.service';
import { InspectionMediaStorageService } from './inspection-media-storage.service';
import {
  MediaProcessingService,
  ROOM_SUMMARY_TITLE,
  ROOM_SUMMARY_WHERE,
} from './media-processing.service';
import type {
  TechnicianFindingsQueryDto,
  TechnicianInspectionListQueryDto,
  TechnicianMediaUploadDto,
} from './technician.dto';

export interface UploadedRoomVideo {
  path: string;
  mimetype: string;
  size: number;
  originalname: string;
}

const allowedVideoMimeTypes = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/3gpp',
  'video/x-matroska',
]);

// Propertyware unit names vary ("A", "304", "Unit B"); label consistently.
function formatUnitLabel(name: string) {
  return /^(unit|apt|apartment|suite|ste|#)\b/i.test(name.trim())
    ? name.trim()
    : `Unit ${name.trim()}`;
}

const visibleStatuses = { not: InspectionStatus.CANCELLED } as const;

const technicianRoomSelect = {
  id: true,
  inspectionId: true,
  propertyAreaId: true,
  completionStatus: true,
  skipReason: true,
  technicianNote: true,
  inspection: { select: { inspectionType: true, baselineInspectionId: true } },
  propertyArea: {
    select: {
      name: true,
      inspectionOrder: true,
      isRequired: true,
      floor: { select: { name: true } },
      baselineConditions: {
        orderBy: { baselineInspection: { inspectedAt: 'desc' as const } },
        take: 1,
        select: { conditionSummary: true, knownDefects: true },
      },
    },
  },
  media: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { uploadStatus: true, processingStatus: true },
  },
} satisfies Prisma.InspectionAreaSelect;

const technicianInspectionSummarySelect = {
  id: true,
  inspectionType: true,
  baselineInspectionId: true,
  baselineInspection: { select: { scheduledAt: true, completedAt: true } },
  scheduledAt: true,
  status: true,
  priority: true,
  internalNotes: true,
  propertywareUnit: {
    select: { id: true, name: true, bedrooms: true, bathrooms: true },
  },
  propertywareBuilding: {
    select: {
      id: true,
      name: true,
      addressLine1: true,
      city: true,
      state: true,
      postalCode: true,
    },
  },
  areas: {
    select: {
      id: true,
      completionStatus: true,
      propertyArea: { select: { isRequired: true } },
      media: {
        orderBy: { createdAt: 'desc' as const },
        take: 1,
        select: { uploadStatus: true },
      },
    },
  },
} satisfies Prisma.InspectionSelect;

const technicianInspectionContextSelect = {
  ...technicianInspectionSummarySelect,
  propertywareBuilding: {
    select: {
      id: true,
      externalId: true,
      externalPortfolioId: true,
      name: true,
      addressLine1: true,
      city: true,
      state: true,
      postalCode: true,
    },
  },
  areas: {
    orderBy: [
      { propertyArea: { floor: { sortOrder: 'asc' as const } } },
      { propertyArea: { inspectionOrder: 'asc' as const } },
    ],
    take: 100,
    select: technicianRoomSelect,
  },
  _count: {
    // Informational room summaries never count as pending review work.
    select: {
      findings: {
        where: { reviewStatus: 'PENDING_REVIEW', NOT: { ...ROOM_SUMMARY_WHERE } },
      },
    },
  },
} satisfies Prisma.InspectionSelect;

type TechnicianInspectionSummaryRecord = Prisma.InspectionGetPayload<{
  select: typeof technicianInspectionSummarySelect;
}>;
type TechnicianRoomRecord = Prisma.InspectionAreaGetPayload<{
  select: typeof technicianRoomSelect;
}>;

@Injectable()
export class TechnicianService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FloorPlanStorageService) private readonly floorPlanStorage: FloorPlanStorageService,
    @Inject(InspectionMediaStorageService)
    private readonly mediaStorage: InspectionMediaStorageService,
    @Inject(MediaProcessingService)
    private readonly mediaProcessing: MediaProcessingService,
  ) {}

  async dashboard(user: AuthenticatedUser) {
    const now = new Date();
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
    const where = {
      organizationId: user.organizationId,
      status: visibleStatuses,
      assignments: { some: { technicianId: user.id, isCurrent: true } },
    } satisfies Prisma.InspectionWhereInput;
    const todayWhere = {
      ...where,
      scheduledAt: { gte: todayStart, lt: tomorrowStart },
    } satisfies Prisma.InspectionWhereInput;
    const [statusGroups, todayTotal, todayRecords, recentRecords, pendingUploads] =
      await Promise.all([
        this.prisma.inspection.groupBy({
          by: ['status'],
          where,
          _count: { _all: true },
        }),
        this.prisma.inspection.count({ where: todayWhere }),
        this.prisma.inspection.findMany({
          relationLoadStrategy: 'join',
          where: todayWhere,
          select: technicianInspectionSummarySelect,
          orderBy: { scheduledAt: 'asc' },
          take: 25,
        }),
        this.prisma.inspection.findMany({
          relationLoadStrategy: 'join',
          where,
          select: technicianInspectionSummarySelect,
          orderBy: { scheduledAt: 'asc' },
          take: 5,
        }),
        this.prisma.inspectionMedia.count({
          where: {
            technicianId: user.id,
            uploadStatus: { not: MediaUploadStatus.UPLOADED },
            inspectionArea: {
              inspection: {
                assignments: { some: { technicianId: user.id, isCurrent: true } },
              },
            },
          },
        }),
      ]);
    const count = (status: InspectionStatus) =>
      statusGroups.find((group) => group.status === status)?._count._all ?? 0;
    return {
      today: todayTotal,
      inProgress: count(InspectionStatus.IN_PROGRESS),
      completed: count(InspectionStatus.COMPLETED),
      pendingUploads,
      assignments: todayRecords.map((record) => this.mapInspection(record, user.id)),
      recent: recentRecords.map((record) => this.mapInspection(record, user.id)),
    };
  }

  async inspections(
    user: AuthenticatedUser,
    query: Pick<TechnicianInspectionListQueryDto, 'page' | 'pageSize' | 'status' | 'search'> = {
      page: 1,
      pageSize: 25,
    },
  ) {
    const where = {
      organizationId: user.organizationId,
      status: query.status ? (query.status as InspectionStatus) : visibleStatuses,
      assignments: { some: { technicianId: user.id, isCurrent: true } },
      ...(query.search
        ? {
            OR: [
              {
                propertywareBuilding: {
                  name: { contains: query.search, mode: 'insensitive' as const },
                },
              },
              {
                propertywareBuilding: {
                  addressLine1: { contains: query.search, mode: 'insensitive' as const },
                },
              },
              {
                propertywareUnit: {
                  name: { contains: query.search, mode: 'insensitive' as const },
                },
              },
            ],
          }
        : {}),
    } satisfies Prisma.InspectionWhereInput;
    const [records, total] = await Promise.all([
      this.prisma.inspection.findMany({
        relationLoadStrategy: 'join',
        where,
        select: technicianInspectionSummarySelect,
        orderBy: { scheduledAt: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.inspection.count({ where }),
    ]);
    return {
      items: records.map((record) => this.mapInspection(record, user.id)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async inspection(user: AuthenticatedUser, id: string) {
    const record = await this.assignedInspection(user, id);
    return this.mapInspection(record, user.id);
  }

  async inspectionContext(user: AuthenticatedUser, id: string) {
    const record = await this.prisma.inspection.findFirst({
      relationLoadStrategy: 'join',
      where: {
        id,
        organizationId: user.organizationId,
        status: visibleStatuses,
        assignments: { some: { technicianId: user.id, isCurrent: true } },
      },
      select: technicianInspectionContextSelect,
    });
    if (!record)
      throw new ApplicationError(
        404,
        'ASSIGNED_INSPECTION_NOT_FOUND',
        'Assigned inspection was not found.',
      );
    const property = this.mapProperty(record.propertywareBuilding, record.propertywareUnit);
    const rooms = record.areas.map((room) => this.mapRoom(room));
    return {
      inspection: this.mapInspection(record, user.id),
      property,
      rooms,
      pendingReviewCount: record._count.findings,
    };
  }

  async startInspection(user: AuthenticatedUser, id: string) {
    const record = await this.assignedInspection(user, id);
    if (record.status !== InspectionStatus.SCHEDULED)
      throw new ApplicationError(
        409,
        'INSPECTION_NOT_STARTABLE',
        'Only a scheduled inspection can be started.',
      );
    const updated = await this.prisma.inspection.update({
      where: { id: record.id },
      data: { status: InspectionStatus.IN_PROGRESS, startedAt: new Date() },
      select: technicianInspectionSummarySelect,
    });
    return this.mapInspection(updated, user.id);
  }

  async completeInspection(user: AuthenticatedUser, id: string) {
    const inspection = await this.assignedInspection(user, id);
    if (inspection.status !== InspectionStatus.IN_PROGRESS)
      throw new ApplicationError(
        409,
        'INSPECTION_NOT_COMPLETABLE',
        'Only an inspection in progress can be completed.',
      );
    const incomplete = await this.prisma.inspectionArea.count({
      where: {
        inspectionId: id,
        propertyArea: { isRequired: true },
        completionStatus: {
          notIn: [InspectionAreaCompletionStatus.COMPLETED, InspectionAreaCompletionStatus.SKIPPED],
        },
      },
    });
    if (incomplete > 0)
      throw new ApplicationError(
        409,
        'REQUIRED_ROOMS_INCOMPLETE',
        'Complete or provide an authorized skip reason for every required room.',
      );
    const updated = await this.prisma.inspection.update({
      where: { id },
      data: { status: InspectionStatus.PROCESSING, completedAt: new Date() },
      select: technicianInspectionSummarySelect,
    });
    // If every recording finished processing before submission, the
    // inspection is immediately ready for human review.
    await this.mediaProcessing.advanceInspection(id);
    return this.mapInspection(updated, user.id);
  }

  async property(user: AuthenticatedUser, id: string) {
    const property = await this.prisma.propertywareBuilding.findFirst({
      relationLoadStrategy: 'join',
      where: {
        id,
        organizationId: user.organizationId,
        inspections: {
          some: { assignments: { some: { technicianId: user.id, isCurrent: true } } },
        },
      },
      select: {
        id: true,
        externalId: true,
        externalPortfolioId: true,
        name: true,
        addressLine1: true,
        city: true,
        state: true,
        postalCode: true,
        units: {
          where: { isActive: true },
          orderBy: { name: 'asc' },
          take: 1,
          select: { bedrooms: true, bathrooms: true },
        },
      },
    });
    if (!property)
      throw new ApplicationError(404, 'ASSIGNED_PROPERTY_NOT_FOUND', 'Property was not found.');
    return this.mapProperty(property);
  }

  async floorPlan(user: AuthenticatedUser, propertyId: string) {
    await this.assignedProperty(user, propertyId);
    const plan = await this.prisma.propertyFloorPlan.findFirst({
      where: { propertyId, status: FloorPlanStatus.APPROVED },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        sizeBytes: true,
        status: true,
        createdAt: true,
      },
    });
    return plan
      ? {
          ...plan,
          createdAt: plan.createdAt.toISOString(),
          contentPath: `/api/v1/technician/floor-plans/${plan.id}/content`,
        }
      : null;
  }

  async floorPlanContent(user: AuthenticatedUser, floorPlanId: string) {
    const plan = await this.prisma.propertyFloorPlan.findFirst({
      where: {
        id: floorPlanId,
        status: FloorPlanStatus.APPROVED,
        property: { organizationId: user.organizationId },
      },
    });
    if (!plan) throw new ApplicationError(404, 'FLOOR_PLAN_NOT_FOUND', 'Floor plan was not found.');
    await this.assignedProperty(user, plan.propertyId);
    return {
      bytes: await this.floorPlanStorage.get(plan.storageKey),
      fileName: plan.fileName,
      mimeType: plan.mimeType,
    };
  }

  async rooms(user: AuthenticatedUser, inspectionId: string) {
    await this.assignedInspection(user, inspectionId);
    const rooms = await this.prisma.inspectionArea.findMany({
      relationLoadStrategy: 'join',
      where: { inspectionId },
      select: technicianRoomSelect,
      orderBy: [
        { propertyArea: { floor: { sortOrder: 'asc' } } },
        { propertyArea: { inspectionOrder: 'asc' } },
      ],
      take: 100,
    });
    return rooms.map((room) => this.mapRoom(room));
  }

  async room(user: AuthenticatedUser, id: string) {
    const room = await this.assignedRoom(user, id);
    return this.mapRoom(room);
  }

  async updateRoomNote(user: AuthenticatedUser, id: string, note: string) {
    await this.assignedRoom(user, id);
    const room = await this.prisma.inspectionArea.update({
      where: { id },
      data: { technicianNote: note.trim() || null },
      select: technicianRoomSelect,
    });
    return this.mapRoom(room);
  }

  async skipRoom(user: AuthenticatedUser, id: string, reason: string) {
    await this.assignedRoom(user, id);
    const room = await this.prisma.inspectionArea.update({
      where: { id },
      data: {
        completionStatus: InspectionAreaCompletionStatus.SKIPPED,
        skipReason: reason.trim(),
        completedAt: new Date(),
      },
      select: technicianRoomSelect,
    });
    return this.mapRoom(room);
  }

  async completeRoom(user: AuthenticatedUser, id: string) {
    const existing = await this.assignedRoom(user, id);
    if (!existing.media.some((item) => item.uploadStatus === MediaUploadStatus.UPLOADED))
      throw new ApplicationError(
        409,
        'ROOM_VIDEO_REQUIRED',
        'A confirmed uploaded video is required before completing this room.',
      );
    const room = await this.prisma.inspectionArea.update({
      where: { id },
      data: {
        completionStatus: InspectionAreaCompletionStatus.COMPLETED,
        completedAt: new Date(),
        skipReason: null,
      },
      select: technicianRoomSelect,
    });
    return this.mapRoom(room);
  }

  async media(user: AuthenticatedUser, roomId: string) {
    await this.assignedRoom(user, roomId);
    return this.prisma.inspectionMedia.findMany({
      where: { inspectionAreaId: roomId, technicianId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        inspectionId: true,
        inspectionAreaId: true,
        durationSeconds: true,
        createdAt: true,
      },
    });
  }

  async uploadRoomMedia(
    user: AuthenticatedUser,
    roomId: string,
    dto: TechnicianMediaUploadDto,
    file?: UploadedRoomVideo,
  ) {
    try {
      if (!file)
        throw new ApplicationError(400, 'ROOM_VIDEO_FILE_REQUIRED', 'A video file is required.');
      if (!allowedVideoMimeTypes.has(file.mimetype))
        throw new ApplicationError(
          415,
          'ROOM_VIDEO_TYPE_UNSUPPORTED',
          'Only room-video recordings (mp4, mov, webm) can be uploaded.',
        );
      const area = await this.prisma.inspectionArea.findFirst({
        relationLoadStrategy: 'join',
        where: {
          id: roomId,
          inspection: {
            organizationId: user.organizationId,
            status: visibleStatuses,
            assignments: { some: { technicianId: user.id, isCurrent: true } },
          },
        },
        select: {
          id: true,
          inspectionId: true,
          completionStatus: true,
          inspection: {
            select: {
              organizationId: true,
              propertyId: true,
              propertywareBuilding: { select: { addressLine1: true } },
            },
          },
          propertyArea: { select: { name: true } },
          media: { select: { id: true, providerMediaId: true } },
        },
      });
      if (!area)
        throw new ApplicationError(404, 'ASSIGNED_ROOM_NOT_FOUND', 'Assigned room was not found.');

      // Retried uploads reuse the client-generated idempotency key, so a
      // duplicate registration returns the already-stored media unchanged.
      const providerMediaId = `local-${dto.idempotencyKey}`;
      const existing = area.media.find((item) => item.providerMediaId === providerMediaId);
      if (existing) {
        const record = await this.prisma.inspectionMedia.findUniqueOrThrow({
          where: { id: existing.id },
        });
        return this.mapUploadedMedia(record, area);
      }
      if (area.completionStatus === InspectionAreaCompletionStatus.COMPLETED)
        throw new ApplicationError(
          409,
          'ROOM_ALREADY_COMPLETED',
          'This room is completed. Its video can no longer be replaced.',
        );

      await this.mediaStorage.putFromFile(providerMediaId, file.path, file.mimetype);
      const replaced = area.media.map((item) => item.providerMediaId);
      let record;
      try {
        record = await this.prisma.$transaction(async (tx) => {
          // Exactly one video per room: registering a new recording replaces
          // any earlier one for this area.
          await tx.inspectionMedia.deleteMany({ where: { inspectionAreaId: area.id } });
          const created = await tx.inspectionMedia.create({
            data: {
              organizationId: area.inspection.organizationId,
              propertyId: area.inspection.propertyId,
              inspectionId: area.inspectionId,
              inspectionAreaId: area.id,
              technicianId: user.id,
              provider: 'local',
              providerMediaId,
              mimeType: file.mimetype,
              durationSeconds: dto.durationSeconds,
              uploadStatus: MediaUploadStatus.UPLOADED,
              processingStatus: MediaProcessingStatus.PENDING,
            },
          });
          // A fresh recording also un-skips a previously skipped room.
          await tx.inspectionArea.update({
            where: { id: area.id },
            data: {
              completionStatus: InspectionAreaCompletionStatus.COMPLETED,
              completedAt: new Date(),
              skipReason: null,
            },
          });
          return created;
        });
      } catch (error) {
        await this.mediaStorage.delete(providerMediaId).catch(() => undefined);
        throw error;
      }
      for (const key of replaced) await this.mediaStorage.delete(key).catch(() => undefined);
      // Kick off transcription + AI analysis without delaying the upload response.
      this.mediaProcessing.queue(record.id, user.organizationId);
      return this.mapUploadedMedia(record, area);
    } finally {
      if (file) await rm(file.path, { force: true }).catch(() => undefined);
    }
  }

  private mapUploadedMedia(
    record: {
      id: string;
      inspectionId: string;
      inspectionAreaId: string;
      durationSeconds: number;
      uploadStatus: MediaUploadStatus;
      processingStatus: MediaProcessingStatus;
      createdAt: Date;
    },
    area: {
      inspection: { propertywareBuilding: { addressLine1: string | null } | null };
      propertyArea: { name: string };
    },
  ) {
    return {
      id: record.id,
      mediaId: record.id,
      inspectionId: record.inspectionId,
      roomId: record.inspectionAreaId,
      propertyAddress: area.inspection.propertywareBuilding?.addressLine1 ?? 'Assigned property',
      roomName: area.propertyArea.name,
      durationSeconds: record.durationSeconds,
      estimatedSizeMb: 0,
      status: this.mapUploadStatus(record.uploadStatus),
      progress: record.uploadStatus === MediaUploadStatus.UPLOADED ? 1 : 0,
      processingStatus: this.mapProcessingStatus(record.processingStatus),
      processingProgress: record.processingStatus === MediaProcessingStatus.READY ? 1 : 0,
      createdAt: record.createdAt,
    };
  }

  async uploads(user: AuthenticatedUser) {
    const records = await this.prisma.inspectionMedia.findMany({
      relationLoadStrategy: 'join',
      where: {
        technicianId: user.id,
        inspectionArea: {
          inspection: { assignments: { some: { technicianId: user.id, isCurrent: true } } },
        },
      },
      select: {
        id: true,
        inspectionId: true,
        inspectionAreaId: true,
        durationSeconds: true,
        uploadStatus: true,
        processingStatus: true,
        createdAt: true,
        inspectionArea: {
          select: {
            propertyArea: { select: { name: true } },
            inspection: {
              select: {
                propertywareBuilding: { select: { addressLine1: true } },
                propertywareUnit: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return records.map((record) => ({
      id: record.id,
      mediaId: record.id,
      inspectionId: record.inspectionId,
      roomId: record.inspectionAreaId,
      propertyAddress: [
        record.inspectionArea.inspection.propertywareBuilding?.addressLine1 ?? 'Assigned property',
        record.inspectionArea.inspection.propertywareUnit?.name
          ? formatUnitLabel(record.inspectionArea.inspection.propertywareUnit.name)
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
      roomName: record.inspectionArea.propertyArea.name,
      durationSeconds: record.durationSeconds,
      estimatedSizeMb: 0,
      status: this.mapUploadStatus(record.uploadStatus),
      progress: record.uploadStatus === MediaUploadStatus.UPLOADED ? 1 : 0,
      processingStatus: this.mapProcessingStatus(record.processingStatus),
      processingProgress: record.processingStatus === MediaProcessingStatus.READY ? 1 : 0,
      createdAt: record.createdAt,
    }));
  }

  async findings(user: AuthenticatedUser, inspectionId: string, query: TechnicianFindingsQueryDto) {
    await this.assignedInspection(user, inspectionId);
    const where = {
      inspectionId,
      ...(query.reviewStatus ? { reviewStatus: query.reviewStatus as FindingReviewStatus } : {}),
      ...(query.kind === 'SUMMARIES'
        ? { ...ROOM_SUMMARY_WHERE }
        : query.kind === 'DEFECTS'
          ? { NOT: { ...ROOM_SUMMARY_WHERE } }
          : {}),
    } satisfies Prisma.InspectionFindingWhereInput;
    const [records, total] = await Promise.all([
      this.prisma.inspectionFinding.findMany({
        relationLoadStrategy: 'join',
        where,
        select: {
          id: true,
          inspectionId: true,
          propertyAreaId: true,
          title: true,
          category: true,
          severity: true,
          comparisonResult: true,
          confidence: true,
          videoTimestampStart: true,
          videoTimestampEnd: true,
          baselineCondition: true,
          description: true,
          recommendedReview: true,
          reviewStatus: true,
          propertyArea: { select: { name: true } },
          reviews: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { reason: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.inspectionFinding.count({ where }),
    ]);
    return {
      items: records.map((record) => ({
        id: record.id,
        inspectionId: record.inspectionId,
        roomId: record.propertyAreaId,
        roomName: record.propertyArea.name,
        title: record.title,
        category: record.category,
        severity: record.severity,
        comparisonResult: record.comparisonResult,
        confidence: record.confidence,
        videoTimestampStart: record.videoTimestampStart,
        videoTimestampEnd: record.videoTimestampEnd,
        baselineCondition: record.baselineCondition,
        observation: record.description,
        aiSummary: record.description,
        recommendedReview: record.recommendedReview,
        reviewStatus: record.reviewStatus,
        reviewerNotes: record.reviews[0]?.reason,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async report(user: AuthenticatedUser, inspectionId: string) {
    const record = await this.prisma.inspection.findFirst({
      relationLoadStrategy: 'join',
      where: {
        id: inspectionId,
        organizationId: user.organizationId,
        status: visibleStatuses,
        assignments: { some: { technicianId: user.id, isCurrent: true } },
      },
      select: technicianInspectionContextSelect,
    });
    if (!record)
      throw new ApplicationError(
        404,
        'ASSIGNED_INSPECTION_NOT_FOUND',
        'Assigned inspection was not found.',
      );
    const findings = await this.prisma.inspectionFinding.findMany({
      where: { inspectionId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        propertyAreaId: true,
        findingType: true,
        title: true,
        category: true,
        severity: true,
        comparisonResult: true,
        confidence: true,
        description: true,
        recommendedReview: true,
        reviewStatus: true,
      },
    });
    const isSummary = (finding: (typeof findings)[number]) =>
      finding.findingType === 'NO_CHANGE' && finding.title === ROOM_SUMMARY_TITLE;
    const rooms = record.areas.map((area) => {
      const room = this.mapRoom(area);
      const roomFindings = findings.filter(
        (finding) => finding.propertyAreaId === area.propertyAreaId,
      );
      const summary = roomFindings.find(isSummary);
      const defects = roomFindings.filter((finding) => !isSummary(finding));
      return {
        ...room,
        summary: summary?.description ?? null,
        findings: defects.map((finding) => ({
          id: finding.id,
          findingType: finding.findingType,
          title: finding.title,
          category: finding.category,
          severity: finding.severity,
          comparisonResult: finding.comparisonResult,
          confidence: finding.confidence,
          description: finding.description,
          recommendedReview: finding.recommendedReview,
          reviewStatus: finding.reviewStatus,
        })),
      };
    });
    const finished = rooms.filter((room) =>
      ['COMPLETED', 'SKIPPED', 'RECORDING_SAVED'].includes(room.completionStatus),
    );
    return {
      inspection: this.mapInspection(record, user.id),
      property: this.mapProperty(record.propertywareBuilding, record.propertywareUnit),
      generatedAt: new Date().toISOString(),
      rooms,
      totals: {
        rooms: rooms.length,
        finishedRooms: finished.length,
        summaries: rooms.filter((room) => room.summary).length,
        defectFindings: rooms.reduce((sum, room) => sum + room.findings.length, 0),
        pendingReviewCount: record._count.findings,
      },
    };
  }

  private assignedInspection(user: AuthenticatedUser, id: string) {
    return this.prisma.inspection
      .findFirst({
        relationLoadStrategy: 'join',
        where: {
          id,
          organizationId: user.organizationId,
          status: visibleStatuses,
          assignments: { some: { technicianId: user.id, isCurrent: true } },
        },
        select: technicianInspectionSummarySelect,
      })
      .then((record) => {
        if (!record)
          throw new ApplicationError(
            404,
            'ASSIGNED_INSPECTION_NOT_FOUND',
            'Assigned inspection was not found.',
          );
        return record;
      });
  }

  private assignedProperty(user: AuthenticatedUser, id: string) {
    return this.prisma.propertywareBuilding
      .findFirst({
        relationLoadStrategy: 'join',
        where: {
          id,
          organizationId: user.organizationId,
          inspections: {
            some: { assignments: { some: { technicianId: user.id, isCurrent: true } } },
          },
        },
        select: { id: true },
      })
      .then((record) => {
        if (!record)
          throw new ApplicationError(404, 'ASSIGNED_PROPERTY_NOT_FOUND', 'Property was not found.');
        return record;
      });
  }

  private assignedRoom(user: AuthenticatedUser, id: string) {
    return this.prisma.inspectionArea
      .findFirst({
        where: {
          id,
          inspection: {
            organizationId: user.organizationId,
            assignments: { some: { technicianId: user.id, isCurrent: true } },
          },
        },
        select: technicianRoomSelect,
      })
      .then((record) => {
        if (!record)
          throw new ApplicationError(
            404,
            'ASSIGNED_ROOM_NOT_FOUND',
            'Assigned room was not found.',
          );
        return record;
      });
  }

  private mapInspection(record: TechnicianInspectionSummaryRecord, technicianId: string) {
    const requiredAreas = record.areas.filter((area) => area.propertyArea.isRequired);
    const completedAreas = requiredAreas.filter(
      (area) =>
        area.completionStatus === InspectionAreaCompletionStatus.COMPLETED ||
        area.completionStatus === InspectionAreaCompletionStatus.SKIPPED,
    );
    return {
      id: record.id,
      externalInspectionId: record.id,
      propertyId: record.propertywareBuilding?.id ?? '',
      type: record.inspectionType,
      baselineInspectionId: record.baselineInspectionId,
      baselineScheduledAt: record.baselineInspection?.scheduledAt.toISOString(),
      scheduledAt: record.scheduledAt.toISOString(),
      assignedUserId: technicianId,
      status: this.mapInspectionStatus(record.status),
      priority: record.priority,
      unitId: record.propertywareUnit?.id ?? null,
      unitName: record.propertywareUnit?.name ?? null,
      roomIds: record.areas.map((area) => area.id),
      propertyNotes: record.internalNotes ?? '',
      property: this.mapPropertySummary(record.propertywareBuilding, record.propertywareUnit?.name),
      progress: {
        completed: completedAreas.length,
        total: requiredAreas.length,
        hasFailedUpload: record.areas.some(
          (area) => area.media[0]?.uploadStatus === MediaUploadStatus.FAILED,
        ),
      },
    };
  }

  private mapRoom(record: TechnicianRoomRecord) {
    const establishesBaseline = record.inspection.inspectionType === InspectionType.MOVE_IN;
    const baseline = establishesBaseline ? undefined : record.propertyArea.baselineConditions[0];
    const latestMedia = record.media[0];
    return {
      id: record.id,
      inspectionId: record.inspectionId,
      propertyAreaId: record.propertyAreaId,
      name: record.propertyArea.name,
      floorName: record.propertyArea.floor?.name ?? 'Property',
      order: record.propertyArea.inspectionOrder,
      isRequired: record.propertyArea.isRequired,
      inspectionType: record.inspection.inspectionType,
      baseline: {
        summary: establishesBaseline
          ? 'This move-in inspection establishes the initial condition for future comparisons.'
          : (baseline?.conditionSummary ??
            (record.inspection.baselineInspectionId
              ? 'The completed move-in inspection is linked as the comparison baseline.'
              : 'No move-in baseline is available.')),
        condition: baseline
          ? 'DOCUMENTED'
          : record.inspection.baselineInspectionId
            ? 'LIMITED'
            : 'NOT_AVAILABLE',
        existingDefects: Array.isArray(baseline?.knownDefects)
          ? baseline.knownDefects.filter((item): item is string => typeof item === 'string')
          : [],
        evidenceCount: 0,
      },
      completionStatus: this.mapRoomStatus(record.completionStatus),
      uploadStatus: latestMedia ? this.mapUploadStatus(latestMedia.uploadStatus) : 'PENDING',
      processingStatus: latestMedia
        ? this.mapProcessingStatus(latestMedia.processingStatus)
        : 'NOT_STARTED',
      note: record.technicianNote ?? undefined,
      skipReason: record.skipReason ?? undefined,
    };
  }

  private mapPropertySummary(
    property: TechnicianInspectionSummaryRecord['propertywareBuilding'],
    unitName?: string | null,
  ) {
    const baseAddress = property?.addressLine1 ?? property?.name ?? 'Assigned property';
    return {
      id: property?.id ?? '',
      address: unitName ? `${baseAddress} · ${formatUnitLabel(unitName)}` : baseAddress,
      cityStateZip: [property?.city, property?.state, property?.postalCode]
        .filter(Boolean)
        .join(', '),
      imageTone: 'navy' as const,
    };
  }

  private mapProperty(
    property: {
      id: string;
      externalId: string;
      externalPortfolioId: string;
      name: string;
      addressLine1: string | null;
      city: string | null;
      state: string | null;
      postalCode: string | null;
      units?: Array<{ bedrooms: number | null; bathrooms: number | null }>;
    } | null,
    // The inspection's actual unit. Without it (standalone property reads)
    // bedroom/bathroom counts fall back to the building's first active unit.
    unit?: { name: string; bedrooms: number | null; bathrooms: number | null } | null,
  ) {
    if (!property)
      throw new ApplicationError(404, 'ASSIGNED_PROPERTY_NOT_FOUND', 'Property was not found.');
    const unitInfo = unit ?? property.units?.[0] ?? null;
    const baseAddress = property.addressLine1 ?? property.name;
    return {
      id: property.id,
      externalPropertyId: property.externalId,
      externalOwnerId: '',
      externalPortfolioId: property.externalPortfolioId,
      name: property.name,
      address: unit?.name ? `${baseAddress} · ${formatUnitLabel(unit.name)}` : baseAddress,
      unitName: unit?.name ?? null,
      cityStateZip: [property.city, property.state, property.postalCode].filter(Boolean).join(', '),
      bedrooms: unitInfo?.bedrooms ?? 0,
      bathrooms: unitInfo?.bathrooms ?? 0,
      floors: [],
      accessInstructions: '',
      notes: '',
      imageTone: 'navy' as const,
    };
  }

  private mapInspectionStatus(status: InspectionStatus) {
    if (status === InspectionStatus.SCHEDULED) return 'SCHEDULED';
    if (status === InspectionStatus.IN_PROGRESS) return 'IN_PROGRESS';
    if (status === InspectionStatus.PROCESSING) return 'PROCESSING';
    if (status === InspectionStatus.REVIEW_REQUIRED) return 'REVIEW_REQUIRED';
    if (status === InspectionStatus.COMPLETED) return 'COMPLETED';
    throw new ApplicationError(500, 'INVALID_INSPECTION_STATUS', 'Invalid inspection status.');
  }
  private mapRoomStatus(status: InspectionAreaCompletionStatus) {
    if (status === InspectionAreaCompletionStatus.SKIPPED) return 'SKIPPED';
    if (status === InspectionAreaCompletionStatus.COMPLETED) return 'COMPLETED';
    if (status === InspectionAreaCompletionStatus.RECORDED) return 'RECORDING_SAVED';
    return 'NOT_STARTED';
  }
  private mapUploadStatus(status: MediaUploadStatus) {
    if (status === MediaUploadStatus.UPLOADING) return 'UPLOADING';
    if (status === MediaUploadStatus.UPLOADED) return 'COMPLETED';
    if (status === MediaUploadStatus.FAILED) return 'FAILED';
    return 'PENDING';
  }
  private mapProcessingStatus(status: MediaProcessingStatus) {
    if (status === MediaProcessingStatus.PROCESSING) return 'VIDEO_PROCESSING';
    if (status === MediaProcessingStatus.READY) return 'READY_FOR_REVIEW';
    if (status === MediaProcessingStatus.FAILED) return 'FAILED';
    return 'NOT_STARTED';
  }
}
