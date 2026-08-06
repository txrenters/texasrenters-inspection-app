import { Inject, Injectable } from '@nestjs/common';
import { FindingReviewStatus, PhotoCaptureType, VideoRecordingType } from '@prisma/client';
import type {
  AreaEvidenceBundle,
  AreaEvidenceSummary,
  AreaPhotoGroup,
  AreaReviewStatus,
} from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { thumbnailKeyFor } from '../common/object-storage';
import { PrismaService } from '../common/prisma.service';
import { InspectionMediaStorageService } from '../technician/inspection-media-storage.service';
import { ROOM_SUMMARY_WHERE } from '../technician/media-processing.service';

/** Findings awaiting a human decision. */
const UNREVIEWED: FindingReviewStatus[] = [FindingReviewStatus.PENDING_REVIEW];

/**
 * Area-first read model over inspection evidence.
 *
 * Aggregates existing records; it owns no tables of its own. The summary is
 * deliberately media-free so the review screen can list every area without
 * pulling a single byte of video or image.
 */
@Injectable()
export class AreaEvidenceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InspectionMediaStorageService)
    private readonly mediaStorage: InspectionMediaStorageService,
  ) {}

  /**
   * Where an area stands, derived rather than stored.
   *
   * Order matters and encodes what a reviewer most needs to act on. A failed
   * upload outranks everything because the evidence itself is broken; a pending
   * decision outranks "ready" because the area is not actually finished. A
   * stored column would have to be rewritten on every media and finding
   * transition, and would be wrong whenever that write was missed.
   */
  private reviewStatusFor(input: {
    completionStatus: string;
    isRequired: boolean;
    recordings: number;
    photos: number;
    hasPrimaryRecording: boolean;
    processingFailed: boolean;
    processingPending: boolean;
    findings: number;
    unreviewedFindings: number;
    followUpFindings: number;
  }): AreaReviewStatus {
    if (input.processingFailed) return 'FAILED';
    if (input.completionStatus === 'FAILED') return 'FAILED';
    if (!input.recordings && !input.photos)
      return input.completionStatus === 'SKIPPED' ? 'EVIDENCE_INCOMPLETE' : 'NOT_STARTED';
    if (input.followUpFindings) return 'FOLLOW_UP_REQUIRED';
    if (input.processingPending) return 'ANALYSIS_PROCESSING';
    if (input.unreviewedFindings) return 'FINDINGS_NEED_REVIEW';
    // A required area without its walkthrough is incomplete even if photos and
    // decided findings exist — the primary recording is the mandated evidence.
    if (input.isRequired && !input.hasPrimaryRecording) return 'EVIDENCE_INCOMPLETE';
    if (input.completionStatus === 'SKIPPED') return 'EVIDENCE_INCOMPLETE';
    return input.findings ? 'REVIEWED' : 'EVIDENCE_READY';
  }

  /**
   * Every area with counts and status, and no media payloads.
   *
   * Uses a constant number of grouped queries regardless of how many areas the
   * inspection has, so a 40-area property costs the same round trips as a
   * 4-area one.
   */
  async summary(user: AuthenticatedUser, inspectionId: string): Promise<AreaEvidenceSummary> {
    await this.requireInspection(user.organizationId, inspectionId);
    const areas = await this.prisma.inspectionArea.findMany({
      where: { inspectionId },
      orderBy: { propertyArea: { inspectionOrder: 'asc' } },
      select: {
        id: true,
        completionStatus: true,
        propertyArea: {
          select: {
            id: true,
            name: true,
            environment: true,
            isRequired: true,
            // Counted in the same query rather than fetched per area from the
            // client: the list can hold thirty areas, and thirty extra requests
            // to render a badge is not worth it.
            _count: { select: { checklistItems: { where: { archivedAt: null } } } },
            floor: { select: { name: true } },
          },
        },
      },
    });
    if (!areas.length)
      return {
        inspectionId,
        totals: {
          areas: 0,
          areasReviewed: 0,
          recordings: 0,
          photos: 0,
          findings: 0,
          unreviewedFindings: 0,
        },
        areas: [],
        unassigned: { recordings: 0, photos: 0 },
      };

    const [media, photoGroups, findingGroups, summaryFindings] = await Promise.all([
      // Recordings are few per inspection; the rows carry the flags needed for
      // primary-presence and processing state in one pass.
      this.prisma.inspectionMedia.findMany({
        where: { inspectionId },
        select: {
          inspectionAreaId: true,
          recordingType: true,
          processingStatus: true,
          createdAt: true,
        },
      }),
      // Photos can number in the hundreds, so they are counted, never listed.
      this.prisma.inspectionPhoto.groupBy({
        by: ['inspectionAreaId', 'captureType'],
        where: { inspectionId },
        _count: { _all: true },
        _max: { capturedAt: true },
      }),
      // Findings key on the catalog area, not the inspection area.
      this.prisma.inspectionFinding.groupBy({
        by: ['propertyAreaId', 'reviewStatus'],
        where: { inspectionId, NOT: { ...ROOM_SUMMARY_WHERE } },
        _count: { _all: true },
      }),
      this.prisma.inspectionFinding.groupBy({
        by: ['propertyAreaId'],
        where: { inspectionId, ...ROOM_SUMMARY_WHERE },
        _count: { _all: true },
      }),
    ]);

    const summaryAreas = new Set(summaryFindings.map((row) => row.propertyAreaId));
    const items = areas.map((area) => {
      const areaMedia = media.filter((row) => row.inspectionAreaId === area.id);
      const areaPhotos = photoGroups.filter((row) => row.inspectionAreaId === area.id);
      const areaFindings = findingGroups.filter(
        (row) => row.propertyAreaId === area.propertyArea.id,
      );
      const photos = areaPhotos.reduce((total, row) => total + row._count._all, 0);
      const findings = areaFindings.reduce((total, row) => total + row._count._all, 0);
      const unreviewedFindings = areaFindings
        .filter((row) => UNREVIEWED.includes(row.reviewStatus))
        .reduce((total, row) => total + row._count._all, 0);
      const followUpFindings = areaFindings
        .filter((row) => row.reviewStatus === FindingReviewStatus.REINSPECTION_REQUESTED)
        .reduce((total, row) => total + row._count._all, 0);
      const lastMediaAt = areaMedia.reduce<Date | null>(
        (latest, row) => (!latest || row.createdAt > latest ? row.createdAt : latest),
        null,
      );
      const lastPhotoAt = areaPhotos.reduce<Date | null>(
        (latest, row) =>
          row._max.capturedAt && (!latest || row._max.capturedAt > latest)
            ? row._max.capturedAt
            : latest,
        null,
      );
      const lastEvidence = [lastMediaAt, lastPhotoAt]
        .filter((value): value is Date => Boolean(value))
        .sort((left, right) => right.getTime() - left.getTime())[0];

      return {
        id: area.id,
        propertyAreaId: area.propertyArea.id,
        name: area.propertyArea.name,
        floorName: area.propertyArea.floor?.name ?? null,
        environment: area.propertyArea.environment,
        isRequired: area.propertyArea.isRequired,
        // Optional-chained: not every select variant asks for the count, and a
        // missing badge is not worth crashing the whole evidence list over.
        checklistItemCount: area.propertyArea._count?.checklistItems ?? 0,
        completionStatus: area.completionStatus,
        reviewStatus: this.reviewStatusFor({
          completionStatus: area.completionStatus,
          isRequired: area.propertyArea.isRequired,
          recordings: areaMedia.length,
          photos,
          hasPrimaryRecording: areaMedia.some(
            (row) => row.recordingType === VideoRecordingType.PRIMARY_AREA,
          ),
          processingFailed: areaMedia.some((row) => row.processingStatus === 'FAILED'),
          processingPending: areaMedia.some(
            (row) => row.processingStatus === 'PENDING' || row.processingStatus === 'PROCESSING',
          ),
          findings,
          unreviewedFindings,
          followUpFindings,
        }),
        counts: { recordings: areaMedia.length, photos, findings, unreviewedFindings },
        evidence: {
          primaryRecordingAvailable: areaMedia.some(
            (row) => row.recordingType === VideoRecordingType.PRIMARY_AREA,
          ),
          overviewPhotoAvailable: areaPhotos.some(
            (row) => row.captureType === PhotoCaptureType.AREA_OVERVIEW && row._count._all > 0,
          ),
          conditionSummaryAvailable: summaryAreas.has(area.propertyArea.id),
        },
        lastEvidenceAt: lastEvidence?.toISOString() ?? null,
      };
    });

    const knownAreaIds = new Set(areas.map((area) => area.id));
    return {
      inspectionId,
      totals: {
        areas: items.length,
        areasReviewed: items.filter((area) => area.reviewStatus === 'REVIEWED').length,
        recordings: items.reduce((total, area) => total + area.counts.recordings, 0),
        photos: items.reduce((total, area) => total + area.counts.photos, 0),
        findings: items.reduce((total, area) => total + area.counts.findings, 0),
        unreviewedFindings: items.reduce(
          (total, area) => total + area.counts.unreviewedFindings,
          0,
        ),
      },
      areas: items,
      // Both relations are NOT NULL today, so this is a guard rather than a
      // migration path: evidence must never disappear from the screen because
      // its area link is unexpected.
      unassigned: {
        recordings: media.filter((row) => !knownAreaIds.has(row.inspectionAreaId)).length,
        photos: photoGroups
          .filter((row) => !knownAreaIds.has(row.inspectionAreaId))
          .reduce((total, row) => total + row._count._all, 0),
      },
    };
  }

  /** Everything needed to review one area — and nothing belonging to another. */
  async areaEvidence(
    user: AuthenticatedUser,
    inspectionId: string,
    areaId: string,
  ): Promise<AreaEvidenceBundle> {
    await this.requireInspection(user.organizationId, inspectionId);
    const area = await this.prisma.inspectionArea.findFirst({
      // Scoped by inspection as well as id, so an area id from another
      // inspection cannot be read through this route.
      where: { id: areaId, inspectionId },
      select: {
        id: true,
        completionStatus: true,
        skipReason: true,
        technicianNote: true,
        propertyArea: {
          select: {
            id: true,
            name: true,
            environment: true,
            isRequired: true,
            floor: { select: { name: true } },
          },
        },
      },
    });
    if (!area)
      throw new ApplicationError(404, 'INSPECTION_AREA_NOT_FOUND', 'Inspection area was not found.');

    const [recordings, photos, findings, summaryFinding] = await Promise.all([
      this.prisma.inspectionMedia.findMany({
        where: { inspectionAreaId: area.id },
        orderBy: [{ recordingType: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          storageKey: true,
          recordingType: true,
          label: true,
          category: true,
          durationSeconds: true,
          uploadStatus: true,
          processingStatus: true,
          createdAt: true,
          technician: { select: { displayName: true } },
        },
      }),
      this.prisma.inspectionPhoto.findMany({
        where: { inspectionAreaId: area.id },
        orderBy: [{ captureType: 'asc' }, { sequenceNumber: 'asc' }, { capturedAt: 'asc' }],
        select: {
          id: true,
          captureType: true,
          label: true,
          notes: true,
          sequenceNumber: true,
          width: true,
          height: true,
          capturedAt: true,
          findingId: true,
          capturedBy: { select: { displayName: true } },
        },
      }),
      this.prisma.inspectionFinding.findMany({
        where: {
          inspectionId,
          propertyAreaId: area.propertyArea.id,
          NOT: { ...ROOM_SUMMARY_WHERE },
        },
        orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          title: true,
          description: true,
          category: true,
          findingType: true,
          severity: true,
          comparisonResult: true,
          baselineCondition: true,
          confidence: true,
          reviewStatus: true,
          createdAt: true,
          inspectionMediaId: true,
          videoTimestampStart: true,
          videoTimestampEnd: true,
          _count: { select: { photos: true } },
          reviews: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              status: true,
              reason: true,
              createdAt: true,
              reviewer: { select: { displayName: true } },
            },
          },
        },
      }),
      this.prisma.inspectionFinding.findFirst({
        where: { inspectionId, propertyAreaId: area.propertyArea.id, ...ROOM_SUMMARY_WHERE },
        orderBy: { createdAt: 'desc' },
        select: { id: true, description: true, createdAt: true, reviewStatus: true },
      }),
    ]);

    // Poster frames only. Playback URLs are minted when a recording is opened.
    const thumbnails = await Promise.all(
      recordings.map((recording) =>
        // A Stream-backed recording has no derived R2 thumbnail; Cloudflare
        // supplies one on the media record instead.
        recording.storageKey
          ? this.mediaStorage.signedUrl(thumbnailKeyFor(recording.storageKey)).catch(() => null)
          : Promise.resolve(null),
      ),
    );

    const findingTitles = new Map(findings.map((finding) => [finding.id, finding.title]));
    const groups: AreaPhotoGroup[] = [];
    const overview = photos.filter(
      (photo) => !photo.findingId && photo.captureType === PhotoCaptureType.AREA_OVERVIEW,
    );
    const supporting = photos.filter(
      (photo) => !photo.findingId && photo.captureType !== PhotoCaptureType.AREA_OVERVIEW,
    );
    const mapPhoto = (photo: (typeof photos)[number]) => ({
      id: photo.id,
      captureType: photo.captureType,
      label: photo.label,
      notes: photo.notes,
      sequenceNumber: photo.sequenceNumber,
      width: photo.width,
      height: photo.height,
      capturedAt: photo.capturedAt.toISOString(),
      capturedByName: photo.capturedBy.displayName,
      findingId: photo.findingId,
      contentPath: `/api/v1/admin/photos/${photo.id}/content`,
    });
    if (overview.length)
      groups.push({ key: 'OVERVIEW', label: 'Area overview', photos: overview.map(mapPhoto) });
    // Finding photos stay grouped under the finding they document rather than
    // collapsing into one flat gallery.
    for (const finding of findings) {
      const attached = photos.filter((photo) => photo.findingId === finding.id);
      if (!attached.length) continue;
      groups.push({
        key: 'FINDING',
        label: findingTitles.get(finding.id) ?? 'Finding evidence',
        findingId: finding.id,
        findingTitle: finding.title,
        photos: attached.map(mapPhoto),
      });
    }
    if (supporting.length)
      groups.push({ key: 'SUPPORTING', label: 'Supporting', photos: supporting.map(mapPhoto) });

    const unreviewedFindings = findings.filter((finding) =>
      UNREVIEWED.includes(finding.reviewStatus),
    ).length;

    return {
      area: {
        id: area.id,
        propertyAreaId: area.propertyArea.id,
        name: area.propertyArea.name,
        floorName: area.propertyArea.floor?.name ?? null,
        environment: area.propertyArea.environment,
        isRequired: area.propertyArea.isRequired,
        completionStatus: area.completionStatus,
        reviewStatus: this.reviewStatusFor({
          completionStatus: area.completionStatus,
          isRequired: area.propertyArea.isRequired,
          recordings: recordings.length,
          photos: photos.length,
          hasPrimaryRecording: recordings.some(
            (row) => row.recordingType === VideoRecordingType.PRIMARY_AREA,
          ),
          processingFailed: recordings.some((row) => row.processingStatus === 'FAILED'),
          processingPending: recordings.some(
            (row) => row.processingStatus === 'PENDING' || row.processingStatus === 'PROCESSING',
          ),
          findings: findings.length,
          unreviewedFindings,
          followUpFindings: findings.filter(
            (finding) => finding.reviewStatus === FindingReviewStatus.REINSPECTION_REQUESTED,
          ).length,
        }),
        skipReason: area.skipReason,
        technicianNote: area.technicianNote,
      },
      conditionSummary: summaryFinding
        ? {
            id: summaryFinding.id,
            description: summaryFinding.description,
            createdAt: summaryFinding.createdAt.toISOString(),
            reviewStatus: summaryFinding.reviewStatus,
          }
        : null,
      recordings: recordings.map((recording, index) => ({
        id: recording.id,
        recordingType: recording.recordingType,
        label: recording.label,
        category: recording.category,
        durationSeconds: recording.durationSeconds,
        uploadStatus: recording.uploadStatus,
        processingStatus: recording.processingStatus,
        technicianName: recording.technician.displayName,
        createdAt: recording.createdAt.toISOString(),
        thumbnailUrl: thumbnails[index],
        contentPath: `/api/v1/admin/media/${recording.id}/content`,
      })),
      photoGroups: groups,
      findings: findings.map((finding) => ({
        id: finding.id,
        title: finding.title,
        description: finding.description,
        category: finding.category,
        findingType: finding.findingType,
        severity: finding.severity,
        comparisonResult: finding.comparisonResult,
        baselineCondition: finding.baselineCondition,
        confidence: finding.confidence,
        reviewStatus: finding.reviewStatus,
        createdAt: finding.createdAt.toISOString(),
        recordingId: finding.inspectionMediaId,
        videoTimestampStart: finding.videoTimestampStart,
        videoTimestampEnd: finding.videoTimestampEnd,
        photoCount: finding._count.photos,
        lastReview: finding.reviews[0]
          ? {
              status: finding.reviews[0].status,
              reason: finding.reviews[0].reason,
              reviewerName: finding.reviews[0].reviewer.displayName,
              createdAt: finding.reviews[0].createdAt.toISOString(),
            }
          : null,
      })),
      counts: {
        recordings: recordings.length,
        photos: photos.length,
        findings: findings.length,
        unreviewedFindings,
      },
    };
  }

  private async requireInspection(organizationId: string, inspectionId: string) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId },
      select: { id: true },
    });
    if (!inspection)
      throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
    return inspection;
  }
}
