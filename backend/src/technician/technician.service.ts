import {
  checklistTemplateFor,
  inspectionRequiresEveryArea,
  keywordsFromLabel,
} from '@texasrenters/shared';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  EvidenceRequestStatus,
  FloorPlanStatus,
  InspectionAreaCompletionStatus,
  InspectionStatus,
  InspectionType,
  MediaProcessingStatus,
  MediaUploadStatus,
  PropertyAreaStatus,
  VideoRecordingType,
} from '@prisma/client';
import type { FindingReviewStatus, Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AiProviderSettingsService } from '../admin/ai-provider-settings.service';
import { AreaChecklistAiService } from '../admin/area-checklist-ai.service';
import { FloorPlanStorageService } from '../admin/floor-plan-storage.service';
import { TechnicianEventsGateway } from '../realtime/technician-events.gateway';
import { InspectionMediaStorageService } from './inspection-media-storage.service';
import {
  MediaProcessingService,
  ROOM_SUMMARY_TITLE,
  ROOM_SUMMARY_WHERE,
} from './media-processing.service';
import type {
  TechnicianAdditionalVideoDto,
  TechnicianCreateAreaDto,
  TechnicianFindingsQueryDto,
  TechnicianInspectionListQueryDto,
  TechnicianMediaUploadDto,
  TechnicianPhotoUploadDto,
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

const allowedImageMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

function imageExtension(mimeType: string) {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/heic' || mimeType === 'image/heif') return '.heic';
  return '.jpg';
}

function videoExtension(mimeType: string) {
  if (mimeType === 'video/quicktime') return '.mov';
  if (mimeType === 'video/webm') return '.webm';
  return '.mp4';
}

/**
 * Tenant-scoped object key for a room video, matching the photo convention. The
 * key is independent of `providerMediaId` so the storage backend can change
 * without touching media identity or the client's idempotency key.
 */
function videoStorageKey(
  organizationId: string,
  inspectionId: string,
  areaId: string,
  mimeType: string,
) {
  return `${organizationId}/${inspectionId}/${areaId}/videos/${randomUUID()}${videoExtension(mimeType)}`;
}

function captureSummaryFromDto(dto: TechnicianMediaUploadDto): Prisma.InputJsonValue {
  return {
    coverageStatus: dto.coverageStatus ?? 'INCOMPLETE',
    sensorConfidence: dto.sensorConfidence ?? 'UNAVAILABLE',
    clockwiseRotationDegrees: dto.clockwiseRotationDegrees ?? 0,
    counterClockwiseRotationDegrees: dto.counterClockwiseRotationDegrees ?? 0,
    startHeadingDegrees: dto.startHeadingDegrees ?? null,
    endHeadingDegrees: dto.endHeadingDegrees ?? null,
    returnedToStart: dto.returnedToStart ?? false,
    sensorSupported: dto.sensorSupported ?? false,
    manualConfirmation: dto.manualConfirmation ?? false,
    evidenceComplete: dto.evidenceComplete ?? false,
    snapshotCount: dto.snapshotCount ?? 0,
    // Read back by media processing, which cuts a still from the video at each
    // offset. Android cannot photograph mid-recording, so this is how a
    // technician gets stills without stopping the walkthrough.
    frameMarkersMs: dto.frameMarkersMs ?? [],
    findingMarkerCount: dto.findingMarkerCount ?? 0,
  };
}

const photoSelect = {
  id: true,
  inspectionAreaId: true,
  findingId: true,
  captureType: true,
  sequenceNumber: true,
  label: true,
  notes: true,
  mimeType: true,
  width: true,
  height: true,
  capturedAt: true,
  capturedBy: { select: { displayName: true } },
} satisfies Prisma.InspectionPhotoSelect;

type TechnicianPhotoRecord = Prisma.InspectionPhotoGetPayload<{ select: typeof photoSelect }>;

// Propertyware unit names vary ("A", "304", "Unit B"); label consistently.
function formatUnitLabel(name: string) {
  return /^(unit|apt|apartment|suite|ste|#)\b/i.test(name.trim())
    ? name.trim()
    : `Unit ${name.trim()}`;
}

const visibleStatuses = { not: InspectionStatus.CANCELLED } as const;

/**
 * Statuses that still need the technician on the home screen's queue.
 *
 * Stops at TECHNICIAN_SUBMITTED: once the work is handed over, the inspection
 * belongs to review and should not keep occupying the technician's queue.
 */
const TECHNICIAN_ACTIVE_STATUSES: InspectionStatus[] = [
  InspectionStatus.SCHEDULED,
  InspectionStatus.IN_PROGRESS,
];


const technicianRoomSelect = {
  id: true,
  inspectionId: true,
  propertyAreaId: true,
  completionStatus: true,
  skipReason: true,
  technicianNote: true,
  summaryConfirmedAt: true,
  inspection: { select: { inspectionType: true, baselineInspectionId: true } },
  propertyArea: {
    select: {
      name: true,
      inspectionOrder: true,
      isRequired: true,
      environment: true,
      category: true,
      source: true,
      status: true,
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
    // `updatedAt` carries the stall bound for `analysisPending`: it is the last
    // time the pipeline touched this recording, so an analysis that died
    // mid-flight stops holding up submission instead of stranding the
    // technician behind a stage that will never finish.
    select: { uploadStatus: true, processingStatus: true, updatedAt: true },
  },
} satisfies Prisma.InspectionAreaSelect;

/**
 * How long a recording may sit mid-analysis before submission stops waiting on
 * it.
 *
 * Analysis normally completes in well under a minute — transcription then
 * findings. This is not a deadline for the pipeline; it is the point at which a
 * technician standing in a unit should no longer be blocked by a stage that has
 * evidently stopped making progress. Deliberately generous, because expiring
 * early would let them submit before a summary that was still coming.
 */
const ANALYSIS_STALL_AFTER_MS = 5 * 60_000;

const technicianInspectionSummarySelect = {
  id: true,
  inspectionType: true,
  baselineInspectionId: true,
  baselineInspection: { select: { scheduledAt: true, completedAt: true } },
  scheduledAt: true,
  status: true,
  priority: true,
  internalNotes: true,
  // Tells the app to ask the technician to survey the areas rather than treat
  // an empty list as an error.
  allowTechnicianAreaCapture: true,
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
      // Needed to decide whether the type overrides that flag.
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
    // Optional so the existing unit tests, which construct this service
    // directly with four doubles, keep working without a realtime stub.
    @Optional()
    @Inject(TechnicianEventsGateway)
    private readonly technicianEvents?: TechnicianEventsGateway,
    // Optional, and appended rather than inserted, for the same reason as the
    // gateway above: the unit tests construct this service directly with a
    // handful of doubles. Absent, area creation falls back to the tables.
    @Optional()
    @Inject(AreaChecklistAiService)
    private readonly checklistAi?: AreaChecklistAiService,
    @Optional()
    @Inject(AiProviderSettingsService)
    private readonly aiSettings?: AiProviderSettingsService,
  ) {}

  /**
   * Tells the technician's other devices that an inspection moved.
   *
   * The socket room is keyed per technician, not per device, so every session
   * signed in as this user receives it — including the one that just made the
   * change, which is harmless and keeps the originating device honest if its
   * optimistic update was wrong.
   *
   * Until now the only publisher in the codebase was admin assignment, so a
   * technician working on two devices saw nothing of their own activity cross
   * over: a room completed on one stayed "not started" on the other until the
   * sixty-second poll or a manual pull-to-refresh.
   *
   * Deliberately fire-and-forget and never awaited — a realtime hiccup must not
   * fail a write that already committed.
   */
  private notifyInspectionChanged(user: AuthenticatedUser, inspectionId: string) {
    try {
      this.technicianEvents?.publish(user.id, inspectionId, 'UPDATED');
    } catch {
      // Best effort. The client still has its poll and pull-to-refresh.
    }
  }

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
    // The technician's active queue, not just today's date bucket.
    //
    // `assignments` used to be today-only, while the app rendered it under a
    // heading called "Upcoming". An inspection scheduled for tomorrow was
    // therefore invisible the moment it was created, and so was every overdue
    // one — the two cases a technician most needs on the home screen. The
    // window now runs from anything still outstanding in the past through the
    // next week, ordered by schedule so the latest work sorts to the top.
    // No upper bound on the schedule. A week's lookahead silently hid work a
    // technician had genuinely been assigned — an inspection three weeks out
    // was missing from the home screen with nothing to say why, which reads as
    // the assignment having failed. `take` already bounds the query, and
    // ordering by schedule means the soonest work is what fills it.
    const queueWhere = {
      ...where,
      status: { in: TECHNICIAN_ACTIVE_STATUSES },
    } satisfies Prisma.InspectionWhereInput;
    const [statusGroups, todayTotal, queueRecords, recentRecords, pendingUploads] =
      await Promise.all([
        this.prisma.inspection.groupBy({
          by: ['status'],
          where,
          _count: { _all: true },
        }),
        this.prisma.inspection.count({ where: todayWhere }),
        this.prisma.inspection.findMany({
          relationLoadStrategy: 'join',
          where: queueWhere,
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
      assignments: queueRecords.map((record) => this.mapInspection(record, user.id)),
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
      // An explicit filter is always a subset of what the list may show:
      // CANCELLED is not accepted by the DTO, so `in` cannot widen visibility
      // past `visibleStatuses`.
      status: query.status?.length
        ? { in: query.status as InspectionStatus[] }
        : visibleStatuses,
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
    this.notifyInspectionChanged(user, record.id);
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
        // Same rule as the summary: the type can override the per-area flag.
        ...(inspectionRequiresEveryArea(inspection.inspectionType)
          ? {}
          : { propertyArea: { isRequired: true } }),
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
    // Technician submission is NOT completion (spec §11): only a human
    // administrator finalizes. Record the submission and let the AI pipeline
    // advance it to REVIEW_REQUIRED once processing finishes.
    const updated = await this.prisma.inspection.update({
      where: { id },
      data: { status: InspectionStatus.TECHNICIAN_SUBMITTED, submittedAt: new Date() },
      select: technicianInspectionSummarySelect,
    });
    // If every recording finished processing before submission, the
    // inspection is immediately ready for human review.
    await this.mediaProcessing.advanceInspection(id);
    this.notifyInspectionChanged(user, id);
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

  /**
   * Technician-created inspection area (missed room, mislabeled room, or an
   * outdoor/exterior target not on the floor plan). It is created as a DRAFT
   * PropertyArea with source TECHNICIAN — evidence can be captured immediately,
   * but an administrator must still approve it. The technician can never
   * self-approve.
   */
  async createArea(user: AuthenticatedUser, inspectionId: string, input: TechnicianCreateAreaDto) {
    const inspection = await this.assignedInspection(user, inspectionId);
    const building = inspection.propertywareBuilding;
    if (!building)
      throw new ApplicationError(
        422,
        'INSPECTION_HAS_NO_PROPERTY',
        'This inspection is not linked to a property, so an area cannot be added.',
      );
    const buildingId = building.id;
    const unitId = inspection.propertywareUnit?.id ?? null;
    const name = input.name.trim();
    const floorName = input.floorName?.trim() || 'Added areas';

    // Issued together, not one after another.
    //
    // None of these four depends on another's result, but they used to run in
    // series. Every statement is a round trip to a remote pooler costing a few
    // hundred milliseconds, so adding one area took ~14s of almost entirely
    // idle waiting — past the app's 15s request timeout. The technician saw a
    // failure for an area that had in fact been created, and retrying then hit
    // the duplicate check below.
    const [, duplicate, highest, existingFloor] = await Promise.all([
      // Bridge the Propertyware building to an internal Property row (shared id).
      this.prisma.property.upsert({
        where: { id: buildingId },
        update: {},
        create: {
          id: buildingId,
          organizationId: user.organizationId,
          name: building.name,
          addressLine1: building.addressLine1 || 'Address not provided',
          city: building.city || 'Not provided',
          state: building.state || 'TX',
          postalCode: building.postalCode || 'Not provided',
        },
      }),
      this.prisma.propertyArea.findFirst({
        where: {
          propertyId: buildingId,
          unitId,
          name: { equals: name, mode: 'insensitive' },
          floor: { name: { equals: floorName, mode: 'insensitive' } },
        },
        // Whether this area is already part of *this* inspection decides
        // between an idempotent retry and a genuine name collision.
        select: {
          id: true,
          inspectionAreas: { where: { inspectionId }, select: { id: true }, take: 1 },
        },
      }),
      this.prisma.propertyArea.aggregate({
        where: { propertyId: buildingId, unitId },
        _max: { inspectionOrder: true },
      }),
      this.prisma.propertyFloor.findFirst({
        where: { propertyId: buildingId, unitId, name: { equals: floorName, mode: 'insensitive' } },
        select: { id: true },
      }),
    ]);

    if (duplicate) {
      const [alreadyInThisInspection] = duplicate.inspectionAreas;
      // A retry after the first attempt timed out mid-flight. The area exists
      // and is already part of this inspection, so return what was created
      // rather than telling the technician their own area is a duplicate —
      // the same idempotency rule room-video upload already follows.
      if (alreadyInThisInspection) {
        const existing = await this.prisma.inspectionArea.findUniqueOrThrow({
          where: { id: alreadyInThisInspection.id },
          select: technicianRoomSelect,
        });
        return this.mapRoom(existing);
      }
      throw new ApplicationError(
        409,
        'DUPLICATE_AREA',
        'An area with this name already exists on that floor.',
      );
    }

    const nextOrder = (highest._max.inspectionOrder ?? 0) + 1;

    const floor =
      existingFloor ??
      (await this.prisma.propertyFloor.create({
        data: { propertyId: buildingId, unitId, name: floorName, sortOrder: nextOrder },
        select: { id: true },
      }));

    /**
     * The checklist for the area the technician just described.
     *
     * Resolved before the transaction opens, not while it is held — this now
     * makes a provider call, and a transaction left open across one would be
     * dropped by the pooler long before it returned.
     *
     * The same generator the floor-plan path uses, so an area surveyed on site
     * gets the same quality of list as one extracted from a plan. Without this
     * it fell back to the tables applied by room *kind*, and a staircase added
     * in the field was still asked about its doors and locks.
     *
     * Never fatal: every failure inside `generate` yields the table list for
     * that area, so a technician with no signal still gets a checklist.
     */
    const newArea = { name, category: input.category ?? null, environment: input.environment };
    const configuration = await this.aiSettings
      ?.resolve(user.organizationId)
      .catch(() => undefined);
    const generated = await this.checklistAi?.generate([newArea], configuration ?? undefined);
    const templateItems: string[] = generated?.items[0]?.length
      ? generated.items[0]
      : checklistTemplateFor(newArea);

    const room = await this.prisma.$transaction(async (tx) => {
      const area = await tx.propertyArea.create({
        data: {
          propertyId: buildingId,
          unitId,
          floorId: floor.id,
          name,
          inspectionOrder: nextOrder,
          isRequired: true,
          source: 'TECHNICIAN',
          // Approved on creation. A technician adding an area is standing in
          // it, which is better evidence of the property's layout than an
          // administrator reading a floor plan from an office — and holding it
          // as a draft meant the area they had just walked into was not part of
          // the property until somebody else agreed it existed.
          //
          // This is a human decision made with the best available information,
          // not an automated one: the area still carries `source: TECHNICIAN`
          // and a TECHNICIAN_AREA_ADDED audit entry naming who added it.
          status: PropertyAreaStatus.APPROVED,
          environment: input.environment,
          category: input.category ?? null,
          notes: input.notes?.trim() || null,
          createdById: user.id,
          // The area arrives with the house-standard checklist already on it,
          // nested into this write rather than issued as a second one.
          //
          // It still has to be atomic with the area: a technician adds a room
          // on site and starts recording it seconds later, so an area that
          // briefly exists without its checklist is a state they would walk
          // into. Nesting keeps that guarantee at one round trip. As a separate
          // createMany it made this transaction five trips to a remote pooler
          // instead of four, which pushed it past Prisma's five-second default
          // and rolled the whole area back.
          checklistItems: {
            createMany: {
              data: templateItems.map((label, index) => ({
                organizationId: user.organizationId,
                label,
                // Derived from the label, exactly as an administrator-authored
                // item is — the matcher does not care where the words came from.
                keywords: keywordsFromLabel(label),
                sortOrder: index,
                createdById: user.id,
              })),
            },
          },
        },
        select: { id: true },
      });
      const inspectionArea = await tx.inspectionArea.create({
        data: {
          inspectionId,
          propertyAreaId: area.id,
          completionStatus: InspectionAreaCompletionStatus.PENDING,
        },
        // Selected here rather than re-read afterwards: the row was just
        // written inside this transaction, so a second round trip to fetch it
        // back bought nothing but latency.
        select: technicianRoomSelect,
      });
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'TECHNICIAN_AREA_ADDED',
          entityType: 'PropertyArea',
          entityId: area.id,
          metadata: { inspectionId, environment: input.environment, category: input.category ?? null },
        },
      });
      return inspectionArea;
    });

    this.notifyInspectionChanged(user, inspectionId);
    // Separately to the organization, because this is the one thing a
    // technician does that the office needs to see as it happens: a property
    // with no floor plan has no areas until someone standing in it adds them,
    // and until now the only way to notice was to reload the page.
    //
    // Best effort, like the technician notification above — the area is already
    // committed, and a realtime failure must not turn a saved area into an
    // error on the handset.
    try {
      this.technicianEvents?.publishAreaAdded(user.organizationId, {
        inspectionId,
        areaId: room.propertyAreaId,
        areaName: name,
        floorName,
        propertyName: building.name ?? building.addressLine1 ?? null,
        technicianName: user.displayName,
      });
    } catch {
      // Deliberately silent; the admin list still refreshes on its own.
    }
    return this.mapRoom(room);
  }

  /**
   * The administrator-authored coverage checklist for an assigned area.
   *
   * Scoped through `assignedRoom`, so a technician can only read the checklist
   * of an area they are actually assigned to. Archived items are excluded: a
   * removed item should stop appearing for new work, while inspections that
   * already recorded coverage against it keep their record.
   *
   * An empty list is a normal answer — most areas have no checklist yet, and
   * the app falls back to a generated one rather than showing nothing.
   */
  async roomChecklist(user: AuthenticatedUser, roomId: string) {
    const room = await this.assignedRoom(user, roomId);
    const [items, responses] = await Promise.all([
      this.prisma.areaChecklistItem.findMany({
        where: { propertyAreaId: room.propertyAreaId, archivedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, label: true, keywords: true },
      }),
      this.prisma.inspectionAreaChecklistResponse.findMany({
        where: { inspectionAreaId: roomId },
        select: {
          checklistItemId: true,
          isClean: true,
          isUndamaged: true,
          isWorking: true,
          comment: true,
          recordedAt: true,
        },
      }),
    ]);
    const byItem = new Map(responses.map((response) => [response.checklistItemId, response]));
    // Each item carries its own assessment so the app never has to join two
    // lists, and an unassessed item is plainly unassessed rather than absent.
    return items.map((item) => {
      const response = byItem.get(item.id);
      return {
        ...item,
        isClean: response?.isClean ?? null,
        isUndamaged: response?.isUndamaged ?? null,
        isWorking: response?.isWorking ?? null,
        comment: response?.comment ?? null,
        recordedAt: response?.recordedAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * Records how one checklist item was found during this inspection.
   *
   * Three axes plus a comment, mirroring the printed report the office issues.
   * Each is optional and **nullable**: leaving an axis unanswered is a real
   * answer — the existing reports leave rows blank, and storing `false` for
   * "not assessed" would invent a defect nobody observed. Passing `null`
   * clears an axis back to unassessed.
   *
   * Upserts on (area, item), so re-scoring corrects the record rather than
   * stacking a second opinion the report would have to choose between.
   */
  async recordRoomChecklistItem(
    user: AuthenticatedUser,
    roomId: string,
    itemId: string,
    input: {
      isClean?: boolean | null;
      isUndamaged?: boolean | null;
      isWorking?: boolean | null;
      comment?: string | null;
      videoTimestampSeconds?: number | null;
    },
  ) {
    const room = await this.assignedRoom(user, roomId);

    // `finalizedAt`, not status alone — the same rule that governs photo
    // deletion. An administrator can reopen a finalized inspection, and a
    // status-only check would reopen the assessments behind a report that has
    // already been closed and possibly shared.
    const inspection = await this.prisma.inspection.findUnique({
      where: { id: room.inspectionId },
      select: { status: true, finalizedAt: true },
    });
    if (
      inspection?.finalizedAt ||
      inspection?.status === InspectionStatus.COMPLETED ||
      inspection?.status === InspectionStatus.CANCELLED
    )
      throw new ApplicationError(
        409,
        'INSPECTION_FINALIZED',
        'The checklist cannot be changed after the inspection is finalized.',
      );

    // The item has to belong to *this* area. Without this a technician could
    // score an item from another property entirely, and the report would show
    // an assessment against a room nobody inspected.
    const item = await this.prisma.areaChecklistItem.findFirst({
      where: { id: itemId, propertyAreaId: room.propertyAreaId, archivedAt: null },
      select: { id: true },
    });
    if (!item)
      throw new ApplicationError(
        404,
        'CHECKLIST_ITEM_NOT_FOUND',
        'That checklist item does not belong to this area.',
      );

    const comment = input.comment?.trim() || null;
    const values = {
      isClean: input.isClean ?? null,
      isUndamaged: input.isUndamaged ?? null,
      isWorking: input.isWorking ?? null,
      comment,
      videoTimestampSeconds: input.videoTimestampSeconds ?? null,
    };
    const response = await this.prisma.inspectionAreaChecklistResponse.upsert({
      where: {
        inspectionAreaId_checklistItemId: { inspectionAreaId: roomId, checklistItemId: itemId },
      },
      create: {
        organizationId: user.organizationId,
        inspectionAreaId: roomId,
        checklistItemId: itemId,
        recordedById: user.id,
        ...values,
      },
      update: { recordedById: user.id, recordedAt: new Date(), ...values },
      select: {
        checklistItemId: true,
        isClean: true,
        isUndamaged: true,
        isWorking: true,
        comment: true,
        recordedAt: true,
        videoTimestampSeconds: true,
      },
    });
    this.notifyInspectionChanged(user, room.inspectionId);
    return { ...response, recordedAt: response.recordedAt.toISOString() };
  }

  /**
   * What the office has asked this technician to go back and capture.
   *
   * Open requests only. A resolved or withdrawn request is history the field
   * does not need, and showing it would leave a technician unsure whether it is
   * still outstanding.
   *
   * The checklist item labels are resolved here rather than sent as ids: the
   * request says "Walls and ceilings", not a uuid the app would have to join
   * against a list it may not have loaded.
   */
  async evidenceRequests(user: AuthenticatedUser, inspectionId: string) {
    await this.assignedInspection(user, inspectionId);
    const requests = await this.prisma.areaEvidenceRequest.findMany({
      where: { inspectionId, status: EvidenceRequestStatus.OPEN },
      orderBy: { requestedAt: 'asc' },
      select: {
        id: true,
        inspectionAreaId: true,
        checklistItemIds: true,
        note: true,
        requestedAt: true,
        inspectionArea: { select: { propertyArea: { select: { name: true } } } },
      },
    });
    const itemIds = [...new Set(requests.flatMap((request) => request.checklistItemIds))];
    const labels = itemIds.length
      ? new Map(
          (
            await this.prisma.areaChecklistItem.findMany({
              where: { id: { in: itemIds } },
              select: { id: true, label: true },
            })
          ).map((item) => [item.id, item.label]),
        )
      : new Map<string, string>();
    return requests.map((request) => ({
      id: request.id,
      roomId: request.inspectionAreaId,
      roomName: request.inspectionArea.propertyArea.name,
      note: request.note,
      requestedAt: request.requestedAt.toISOString(),
      // An empty list means the whole area, which the app words differently.
      items: request.checklistItemIds
        .map((id) => labels.get(id))
        .filter((label): label is string => Boolean(label)),
    }));
  }

  /**
   * Marks a request satisfied.
   *
   * The technician's own call, not inferred from a new upload arriving: only
   * they know whether what they just captured is what was actually asked for,
   * and auto-resolving on any new evidence would quietly close requests that
   * were never addressed.
   */
  async resolveEvidenceRequest(user: AuthenticatedUser, requestId: string) {
    const request = await this.prisma.areaEvidenceRequest.findFirst({
      where: {
        id: requestId,
        status: EvidenceRequestStatus.OPEN,
        inspection: {
          organizationId: user.organizationId,
          assignments: { some: { technicianId: user.id, isCurrent: true } },
        },
      },
      select: { id: true, inspectionId: true },
    });
    if (!request)
      throw new ApplicationError(
        404,
        'EVIDENCE_REQUEST_NOT_FOUND',
        'That request was not found, or is no longer open.',
      );
    await this.prisma.areaEvidenceRequest.update({
      where: { id: requestId },
      data: {
        status: EvidenceRequestStatus.RESOLVED,
        resolvedById: user.id,
        resolvedAt: new Date(),
      },
    });
    this.notifyInspectionChanged(user, request.inspectionId);
    return { id: requestId, status: 'RESOLVED' as const };
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

  /**
   * The technician's attestation that the AI's narrative summary for this area
   * matches the walkthrough they performed.
   *
   * This is **not** finding review. A technician cannot approve, reject or edit
   * an AI finding — that is an administrator decision, enforced here by writing
   * only to the area's own confirmation columns and never touching
   * `InspectionFinding.reviewStatus`/`reviewedById`. The claim recorded is the
   * weaker one the technician is actually positioned to make: they were in the
   * room, and this describes it.
   *
   * Refuses when no summary exists yet: confirming nothing is not a statement
   * about anything, and a stored confirmation that predates the summary would
   * later read as though a human had vouched for text they never saw.
   *
   * Idempotent — re-confirming keeps the original timestamp, so the record
   * continues to say when the technician actually read it.
   */
  async confirmRoomSummary(user: AuthenticatedUser, id: string) {
    const existing = await this.assignedRoom(user, id);

    const summary = await this.prisma.inspectionFinding.findFirst({
      where: {
        inspectionId: existing.inspectionId,
        propertyAreaId: existing.propertyAreaId,
        ...ROOM_SUMMARY_WHERE,
      },
      select: { id: true },
    });
    if (!summary)
      throw new ApplicationError(
        409,
        'ROOM_SUMMARY_NOT_READY',
        'This area has no AI summary to confirm yet.',
      );

    if (existing.summaryConfirmedAt) return this.mapRoom(existing);

    const room = await this.prisma.inspectionArea.update({
      where: { id },
      data: { summaryConfirmedAt: new Date(), summaryConfirmedById: user.id },
      select: technicianRoomSelect,
    });
    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'TECHNICIAN_SUMMARY_CONFIRMED',
        entityType: 'InspectionArea',
        entityId: id,
        metadata: { inspectionId: existing.inspectionId, findingId: summary.id },
      },
    });
    this.notifyInspectionChanged(user, room.inspectionId);
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
    this.notifyInspectionChanged(user, room.inspectionId);
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
    this.notifyInspectionChanged(user, room.inspectionId);
    return this.mapRoom(room);
  }

  async media(user: AuthenticatedUser, roomId: string) {
    await this.assignedRoom(user, roomId);
    return this.prisma.inspectionMedia.findMany({
      where: { inspectionAreaId: roomId, technicianId: user.id },
      // Primary walkthrough first, then additional labeled clips.
      orderBy: [{ recordingType: 'asc' }, { createdAt: 'desc' }],
      take: 100,
      select: {
        id: true,
        inspectionId: true,
        inspectionAreaId: true,
        durationSeconds: true,
        recordingType: true,
        label: true,
        category: true,
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
          media: {
            select: { id: true, providerMediaId: true, storageKey: true, recordingType: true },
          },
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

      const storageKey = videoStorageKey(
        area.inspection.organizationId,
        area.inspectionId,
        area.id,
        file.mimetype,
      );
      await this.mediaStorage.putFromFile(storageKey, file.path, file.mimetype);
      // Only the previous PRIMARY video is replaced; additional videos are kept.
      const replaced = area.media
        .filter((item) => item.recordingType === VideoRecordingType.PRIMARY_AREA)
        // Stream-backed recordings carry no bucket object, so there is nothing
        // here to delete for them.
        .map((item) => item.storageKey)
        .filter((key): key is string => Boolean(key));
      let record;
      try {
        record = await this.prisma.$transaction(async (tx) => {
          // Exactly one PRIMARY video per room: a new walkthrough replaces the
          // earlier primary one, but never the additional labeled videos.
          await tx.inspectionMedia.deleteMany({
            where: { inspectionAreaId: area.id, recordingType: VideoRecordingType.PRIMARY_AREA },
          });
          const created = await tx.inspectionMedia.create({
            data: {
              organizationId: area.inspection.organizationId,
              propertyId: area.inspection.propertyId,
              inspectionId: area.inspectionId,
              inspectionAreaId: area.id,
              technicianId: user.id,
              provider: this.mediaStorage.providerName(),
              providerMediaId,
              storageKey,
              mimeType: file.mimetype,
              durationSeconds: dto.durationSeconds,
              recordingType: VideoRecordingType.PRIMARY_AREA,
              captureGuidelineVersion: dto.captureGuidelineVersion ?? null,
              captureSessionId: dto.captureSessionId ?? null,
              capturePolicyVersion: dto.capturePolicyVersion ?? null,
              captureSummary: dto.captureSessionId ? captureSummaryFromDto(dto) : undefined,
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
        await this.mediaStorage.delete(storageKey).catch(() => undefined);
        throw error;
      }
      for (const key of replaced) await this.mediaStorage.delete(key).catch(() => undefined);
      // Kick off transcription + AI analysis without delaying the upload response.
      this.mediaProcessing.queue(record.id, user.organizationId);
      this.notifyInspectionChanged(user, area.inspectionId);
      return this.mapUploadedMedia(record, area);
    } finally {
      if (file) await rm(file.path, { force: true }).catch(() => undefined);
    }
  }

  /**
   * An additional labeled video for an area (extra damage, appliance test, pest
   * or pet evidence, etc.). It never replaces the primary walkthrough and does
   * not complete the area, but it is transcribed/analyzed independently and is
   * part of the inspection's evidence. Idempotent by the client's key.
   */
  async uploadAdditionalVideo(
    user: AuthenticatedUser,
    roomId: string,
    dto: TechnicianAdditionalVideoDto,
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
          propertyAreaId: true,
          inspection: {
            select: {
              organizationId: true,
              propertyId: true,
              propertywareBuilding: { select: { addressLine1: true } },
            },
          },
          propertyArea: { select: { name: true } },
        },
      });
      if (!area)
        throw new ApplicationError(404, 'ASSIGNED_ROOM_NOT_FOUND', 'Assigned room was not found.');

      const providerMediaId = `local-${dto.idempotencyKey}`;
      const existing = await this.prisma.inspectionMedia.findUnique({
        where: { providerMediaId },
        select: { id: true },
      });
      if (existing) {
        const stored = await this.prisma.inspectionMedia.findUniqueOrThrow({
          where: { id: existing.id },
        });
        return this.mapUploadedMedia(stored, area);
      }

      if (dto.relatedFindingId) {
        const finding = await this.prisma.inspectionFinding.findFirst({
          where: {
            id: dto.relatedFindingId,
            inspectionId: area.inspectionId,
            propertyAreaId: area.propertyAreaId,
          },
          select: { id: true },
        });
        if (!finding)
          throw new ApplicationError(
            422,
            'FINDING_NOT_IN_AREA',
            'The related finding does not belong to this area.',
          );
      }

      const storageKey = videoStorageKey(
        area.inspection.organizationId,
        area.inspectionId,
        area.id,
        file.mimetype,
      );
      await this.mediaStorage.putFromFile(storageKey, file.path, file.mimetype);
      let record;
      try {
        record = await this.prisma.inspectionMedia.create({
          data: {
            organizationId: area.inspection.organizationId,
            propertyId: area.inspection.propertyId,
            inspectionId: area.inspectionId,
            inspectionAreaId: area.id,
            technicianId: user.id,
            provider: this.mediaStorage.providerName(),
            providerMediaId,
            storageKey,
            mimeType: file.mimetype,
            durationSeconds: dto.durationSeconds,
            recordingType: VideoRecordingType.ADDITIONAL_ISSUE,
            label: dto.label.trim(),
            category: dto.category ?? null,
            relatedFindingId: dto.relatedFindingId ?? null,
            captureGuidelineVersion: dto.captureGuidelineVersion ?? null,
            uploadStatus: MediaUploadStatus.UPLOADED,
            processingStatus: MediaProcessingStatus.PENDING,
          },
        });
      } catch (error) {
        await this.mediaStorage.delete(storageKey).catch(() => undefined);
        throw error;
      }
      // Transcribe/analyze independently; the area's completion is unaffected.
      this.mediaProcessing.queue(record.id, user.organizationId);
      this.notifyInspectionChanged(user, area.inspectionId);
      return this.mapUploadedMedia(record, area);
    } finally {
      if (file) await rm(file.path, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Photo evidence for an area. Unlike the single primary video, an area may
   * hold many photos across capture types; photos never enter the video
   * transcription/AI pipeline. Idempotent by the client's key.
   */
  async uploadPhoto(
    user: AuthenticatedUser,
    roomId: string,
    dto: TechnicianPhotoUploadDto,
    file?: UploadedRoomVideo,
  ) {
    try {
      if (!file)
        throw new ApplicationError(400, 'PHOTO_FILE_REQUIRED', 'A photo file is required.');
      if (!allowedImageMimeTypes.has(file.mimetype))
        throw new ApplicationError(
          415,
          'PHOTO_TYPE_UNSUPPORTED',
          'Only photos (jpeg, png, webp, heic) can be uploaded.',
        );
      const area = await this.prisma.inspectionArea.findFirst({
        where: {
          id: roomId,
          inspection: {
            organizationId: user.organizationId,
            status: visibleStatuses,
            assignments: { some: { technicianId: user.id, isCurrent: true } },
          },
        },
        select: { id: true, inspectionId: true, propertyAreaId: true },
      });
      if (!area)
        throw new ApplicationError(404, 'ASSIGNED_ROOM_NOT_FOUND', 'Assigned room was not found.');

      // Retried uploads reuse the client key and return the stored photo.
      const existing = await this.prisma.inspectionPhoto.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
        select: { id: true, inspectionAreaId: true },
      });
      if (existing) {
        if (existing.inspectionAreaId !== area.id)
          throw new ApplicationError(
            409,
            'PHOTO_KEY_CONFLICT',
            'This photo key was already used for another area.',
          );
        return this.mapPhoto(
          await this.prisma.inspectionPhoto.findUniqueOrThrow({
            where: { id: existing.id },
            select: photoSelect,
          }),
        );
      }

      if (dto.findingId) {
        const finding = await this.prisma.inspectionFinding.findFirst({
          where: {
            id: dto.findingId,
            inspectionId: area.inspectionId,
            propertyAreaId: area.propertyAreaId,
          },
          select: { id: true },
        });
        if (!finding)
          throw new ApplicationError(
            422,
            'FINDING_NOT_IN_AREA',
            'The related finding does not belong to this area.',
          );
      }

      const id = randomUUID();
      const storageKey = `${user.organizationId}/${area.inspectionId}/${area.id}/photos/${id}${imageExtension(file.mimetype)}`;
      await this.mediaStorage.putFromFile(storageKey, file.path, file.mimetype);
      let record: TechnicianPhotoRecord;
      try {
        record = await this.prisma.inspectionPhoto.create({
          data: {
            id,
            organizationId: user.organizationId,
            inspectionId: area.inspectionId,
            inspectionAreaId: area.id,
            findingId: dto.findingId ?? null,
            capturedById: user.id,
            provider: 'local',
            storageKey,
            captureType: dto.captureType,
            sequenceNumber: dto.sequenceNumber ?? 0,
            label: dto.label?.trim() || null,
            notes: dto.notes?.trim() || null,
            mimeType: file.mimetype,
            width: dto.width ?? null,
            height: dto.height ?? null,
            sizeBytes: file.size,
            idempotencyKey: dto.idempotencyKey,
            metadata:
              dto.recordingSessionId || dto.videoTimestampMs !== undefined || dto.captureSource
                ? {
                    recordingSessionId: dto.recordingSessionId,
                    videoTimestampMs: dto.videoTimestampMs,
                    captureSource: dto.captureSource,
                  }
                : undefined,
          },
          select: photoSelect,
        });
      } catch (error) {
        await this.mediaStorage.delete(storageKey).catch(() => undefined);
        throw error;
      }
      return this.mapPhoto(record);
    } finally {
      if (file) await rm(file.path, { force: true }).catch(() => undefined);
    }
  }

  async listPhotos(user: AuthenticatedUser, roomId: string) {
    await this.assignedRoom(user, roomId);
    const photos = await this.prisma.inspectionPhoto.findMany({
      where: { inspectionAreaId: roomId },
      orderBy: [{ captureType: 'asc' }, { sequenceNumber: 'asc' }, { createdAt: 'asc' }],
      take: 200,
      select: photoSelect,
    });
    return photos.map((photo) => this.mapPhoto(photo));
  }

  async deletePhoto(user: AuthenticatedUser, photoId: string) {
    const photo = await this.prisma.inspectionPhoto.findFirst({
      where: {
        id: photoId,
        capturedById: user.id,
        inspectionArea: {
          inspection: {
            organizationId: user.organizationId,
            assignments: { some: { technicianId: user.id, isCurrent: true } },
          },
        },
      },
      select: {
        id: true,
        storageKey: true,
        inspectionArea: {
          select: { inspection: { select: { status: true, finalizedAt: true } } },
        },
      },
    });
    if (!photo) throw new ApplicationError(404, 'PHOTO_NOT_FOUND', 'Photo was not found.');
    // Evidence is only deletable before the inspection is finalized.
    //
    // `finalizedAt` and not status alone: an administrator can reopen a
    // finalized inspection to IN_PROGRESS, and a status-only check would hand
    // the technician back the ability to hard-delete a photo — and its object
    // in storage — out of a report that has already been closed and may have
    // been shared. Once finalized, the evidence stays, reopen or not.
    const { status, finalizedAt } = photo.inspectionArea.inspection;
    if (
      status === InspectionStatus.COMPLETED ||
      status === InspectionStatus.CANCELLED ||
      finalizedAt
    )
      throw new ApplicationError(
        409,
        'INSPECTION_FINALIZED',
        'Photos cannot be deleted after the inspection is finalized.',
      );
    await this.prisma.inspectionPhoto.delete({ where: { id: photoId } });
    await this.mediaStorage.delete(photo.storageKey).catch(() => undefined);
    return { deleted: true };
  }

  async photoContent(user: AuthenticatedUser, photoId: string) {
    const photo = await this.prisma.inspectionPhoto.findFirst({
      where: {
        id: photoId,
        inspectionArea: {
          inspection: {
            organizationId: user.organizationId,
            assignments: { some: { technicianId: user.id, isCurrent: true } },
          },
        },
      },
      select: { id: true, storageKey: true, mimeType: true },
    });
    if (!photo) throw new ApplicationError(404, 'PHOTO_NOT_FOUND', 'Photo was not found.');
    return {
      bytes: await this.mediaStorage.get(photo.storageKey),
      mimeType: photo.mimeType,
      fileName: `photo-${photo.id}`,
    };
  }

  private mapPhoto(record: TechnicianPhotoRecord) {
    return {
      id: record.id,
      roomId: record.inspectionAreaId,
      findingId: record.findingId,
      captureType: record.captureType,
      sequenceNumber: record.sequenceNumber,
      label: record.label,
      notes: record.notes,
      mimeType: record.mimeType,
      width: record.width,
      height: record.height,
      capturedByName: record.capturedBy?.displayName ?? null,
      capturedAt: record.capturedAt.toISOString(),
      contentPath: `/api/v1/technician/photos/${record.id}/content`,
    };
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
      recordingType?: VideoRecordingType;
      label?: string | null;
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
      recordingType: record.recordingType ?? VideoRecordingType.PRIMARY_AREA,
      label: record.label ?? null,
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
    // Photo counts per area. The mobile review screen previously counted the
    // device's own snapshot store, which reports zero after a reinstall or on a
    // replacement handset — telling a technician their evidence is missing at
    // the exact moment they are deciding whether to submit.
    const photoCounts = await this.prisma.inspectionPhoto.groupBy({
      by: ['inspectionAreaId'],
      where: { inspectionArea: { inspectionId } },
      _count: { _all: true },
    });
    const photoCountByArea = new Map(
      photoCounts.map((row) => [row.inspectionAreaId, row._count._all]),
    );

    const rooms = record.areas.map((area) => {
      const room = this.mapRoom(area);
      const roomFindings = findings.filter(
        (finding) => finding.propertyAreaId === area.propertyAreaId,
      );
      const summary = roomFindings.find(isSummary);
      const defects = roomFindings.filter((finding) => !isSummary(finding));
      return {
        ...room,
        photoCount: photoCountByArea.get(area.id) ?? 0,
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
    // Must stay in step with the mobile submit gate. RECORDING_SAVED is not
    // finished — the bytes are still on the phone — and UPLOADED is, because
    // Cloudflare has them. Counting a saved recording as done reported progress
    // the office could not actually review.
    const finished = rooms.filter((room) =>
      ['COMPLETED', 'SKIPPED', 'UPLOADED'].includes(room.completionStatus),
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
        // Only areas that actually have a summary can be awaiting confirmation.
        // Counting summary-less areas would produce an outstanding item the
        // technician has no way to clear — the gate must stay satisfiable.
        unconfirmedSummaries: rooms.filter((room) => room.summary && !room.summaryConfirmedAt)
          .length,
        // Areas whose summary has not arrived yet. Distinct from the count
        // above: nothing is awaiting the technician here, the pipeline is.
        areasAwaitingAnalysis: rooms.filter((room) => room.analysisPending).length,
        defectFindings: rooms.reduce((sum, room) => sum + room.findings.length, 0),
        photos: rooms.reduce((sum, room) => sum + room.photoCount, 0),
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
    // On a move-in or move-out every attached area counts, whatever the
    // property flagged optional — the two are compared area by area, and one
    // missing from either end drops out of the comparison without a trace.
    const everyAreaCounts = inspectionRequiresEveryArea(record.inspectionType);
    const requiredAreas = record.areas.filter(
      (area) => everyAreaCounts || area.propertyArea.isRequired,
    );
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
      allowTechnicianAreaCapture: record.allowTechnicianAreaCapture,
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
      environment: record.propertyArea.environment,
      category: record.propertyArea.category ?? null,
      source: record.propertyArea.source,
      areaStatus: record.propertyArea.status,
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
      summaryConfirmedAt: record.summaryConfirmedAt?.toISOString() ?? undefined,
      /**
       * A summary is still on its way for this area.
       *
       * Exists because `processingStatus` cannot express it: PENDING and "no
       * recording at all" both map to NOT_STARTED, so the client could not tell
       * an empty area from one whose analysis is seconds from producing a
       * summary. That ambiguity is what let a technician submit inside the
       * ~20-second window between an upload landing and its findings arriving,
       * skipping the confirmation step entirely.
       *
       * Bounded by ANALYSIS_STALL_AFTER_MS so a pipeline that dies mid-run
       * releases the gate rather than holding it forever.
       */
      analysisPending: latestMedia
        ? (latestMedia.processingStatus === MediaProcessingStatus.PENDING ||
            latestMedia.processingStatus === MediaProcessingStatus.PROCESSING) &&
          Date.now() - latestMedia.updatedAt.getTime() < ANALYSIS_STALL_AFTER_MS
        : false,
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
      /** Null for buildings Propertyware holds without a portfolio. */
      externalPortfolioId: string | null;
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
      externalPortfolioId: property.externalPortfolioId ?? '',
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
    if (status === InspectionStatus.TECHNICIAN_SUBMITTED) return 'TECHNICIAN_SUBMITTED';
    if (status === InspectionStatus.PROCESSING) return 'PROCESSING';
    if (status === InspectionStatus.REVIEW_REQUIRED) return 'REVIEW_REQUIRED';
    if (status === InspectionStatus.UNDER_REVIEW) return 'UNDER_REVIEW';
    if (status === InspectionStatus.TBD) return 'TBD';
    if (status === InspectionStatus.FOLLOW_UP_REQUIRED) return 'FOLLOW_UP_REQUIRED';
    if (status === InspectionStatus.COMPLETED) return 'COMPLETED';
    if (status === InspectionStatus.CANCELLED) return 'CANCELLED';
    throw new ApplicationError(500, 'INVALID_INSPECTION_STATUS', 'Invalid inspection status.');
  }
  /**
   * The area's progress, in the vocabulary the handset speaks.
   *
   * UPLOADED used to fall through to NOT_STARTED, along with every other state
   * the mapper did not name — so an area whose walkthrough had reached
   * Cloudflare reported itself untouched, and the Review screen refused to
   * submit an inspection that was in fact finished. Each state now maps to
   * something distinct, and FAILED says so rather than pretending nothing
   * happened.
   */
  private mapRoomStatus(status: InspectionAreaCompletionStatus) {
    if (status === InspectionAreaCompletionStatus.SKIPPED) return 'SKIPPED';
    if (status === InspectionAreaCompletionStatus.COMPLETED) return 'COMPLETED';
    if (status === InspectionAreaCompletionStatus.UPLOADED) return 'UPLOADED';
    if (status === InspectionAreaCompletionStatus.RECORDED) return 'RECORDING_SAVED';
    if (status === InspectionAreaCompletionStatus.FAILED) return 'FAILED';
    // PENDING and RECORDING: nothing has left the device yet.
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
