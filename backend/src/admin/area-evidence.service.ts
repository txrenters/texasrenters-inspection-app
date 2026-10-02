import { Inject, Injectable } from '@nestjs/common';
import { FindingReviewStatus, PhotoCaptureType, VideoRecordingType } from '@prisma/client';
import { checklistKindFor, inspectionRequiresAreaRecording } from '@texasrenters/shared';
import {
  checklistItemsAreOrganizationWide,
  checklistKindWhere,
  checklistSectionFor,
  checklistSectionWhere,
} from '../common/checklist-kind';
import type {
  AreaEvidenceBundle,
  AreaEvidenceSummary,
  AreaPhotoGroup,
  AreaReviewMark,
  AreaReviewStatus,
} from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { inspectedAreas } from '../common/inspected-areas';
import { thumbnailKeyFor } from '../common/object-storage';
import { PrismaService } from '../common/prisma.service';
import { STREAM_ENCODING_FAILED } from '../media/inspection-video.service';
import { InspectionMediaStorageService } from '../technician/inspection-media-storage.service';
import {
  REANALYSIS_COMPLETED_EVENT,
  REANALYSIS_FAILED_EVENT,
  REANALYSIS_STARTED_EVENT,
  ROOM_SUMMARY_WHERE,
  readFrameMarkers,
} from '../technician/media-processing.service';

/** Findings awaiting a human decision. */
const UNREVIEWED: FindingReviewStatus[] = [FindingReviewStatus.PENDING_REVIEW];

const REANALYSIS_EVENTS = [
  REANALYSIS_STARTED_EVENT,
  REANALYSIS_COMPLETED_EVENT,
  REANALYSIS_FAILED_EVENT,
];

/**
 * How long a re-run may say it is running. Longer than any real one, which
 * downloads a walkthrough and makes two provider calls; a start with no end
 * after this died with the server, and saying "running" forever would leave
 * the reviewer waiting on nothing.
 */
const REANALYSIS_STALE_MS = 15 * 60_000;

/** The latest re-run of a recording's AI analysis, from its last event. */
export function reanalysisState(
  event: { eventType: string; createdAt: Date; payloadSummary: unknown } | undefined,
  now = Date.now(),
) {
  if (!event) return null;
  const at = event.createdAt.toISOString();
  if (event.eventType === REANALYSIS_COMPLETED_EVENT) return { status: 'COMPLETED' as const, at };
  if (event.eventType === REANALYSIS_STARTED_EVENT && now - event.createdAt.getTime() < REANALYSIS_STALE_MS)
    return { status: 'RUNNING' as const, at };
  const recorded =
    event.eventType === REANALYSIS_FAILED_EVENT &&
    event.payloadSummary &&
    typeof event.payloadSummary === 'object' &&
    typeof (event.payloadSummary as { message?: unknown }).message === 'string'
      ? (event.payloadSummary as { message: string }).message
      : null;
  return {
    status: 'FAILED' as const,
    at,
    message: recorded ?? 'The re-run stopped before it finished.',
  };
}

/**
 * A recording's processing state, telling apart the two failures FAILED holds.
 *
 * Cloudflare refusing the encode leaves nothing to watch: FAILED. Our own
 * transcription and analysis failing leaves a good recording with no AI
 * suggestions, which a reviewer can still watch and judge: ANALYSIS_FAILED.
 * Read as one, three move-out walkthroughs on 2026-10-01 showed Failed on a
 * room marked Failed, though Cloudflare held every one of them ready to play.
 */
function recordingState(row: { processingStatus: string; failureCode: string | null }) {
  if (row.processingStatus !== 'FAILED') return row.processingStatus;
  return row.failureCode === STREAM_ENCODING_FAILED ? 'FAILED' : 'ANALYSIS_FAILED';
}

/** The latest of some moments, or null when there are none. */
function latest(moments: (Date | null | undefined)[]): Date | null {
  return moments.reduce<Date | null>(
    (found, moment) => (moment && (!found || moment > found) ? moment : found),
    null,
  );
}

/**
 * A reviewer's mark on an area, and whether it still stands.
 *
 * It stands until evidence arrives after it -- a photograph taken on a return
 * visit, a recording uploaded late. Compared with when the server *received*
 * each piece, not when it was captured: a photograph can be taken before a
 * review and only arrive after it, and the reviewer has still not seen it.
 */
function reviewMark(
  area: { reviewedAt: Date | null; reviewedById: string | null },
  lastReceivedAt: Date | null,
  reviewers: Map<string, string>,
): AreaReviewMark | null {
  if (!area.reviewedAt) return null;
  return {
    at: area.reviewedAt.toISOString(),
    byName: area.reviewedById ? (reviewers.get(area.reviewedById) ?? null) : null,
    current: !lastReceivedAt || lastReceivedAt <= area.reviewedAt,
  };
}

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
   * Records how one checklist item was found, during review.
   *
   * The administrator counterpart of the technician's route. Same table, same
   * one-assessment-per-item rule, and the same refusal once the inspection is
   * finalized — `finalizedAt`, not status alone, because an inspection can be
   * reopened and a status-only check would reopen the assessments behind a
   * report that has already been shared.
   *
   * PUT semantics: the body is the item's complete assessment, so clearing a
   * control clears it on the server rather than leaving a value the report
   * would still print.
   */
  async recordChecklistItem(
    user: AuthenticatedUser,
    inspectionId: string,
    areaId: string,
    itemId: string,
    input: {
      isClean?: boolean | null;
      isUndamaged?: boolean | null;
      isWorking?: boolean | null;
      comment?: string | null;
      videoTimestampSeconds?: number | null;
    },
  ) {
    await this.requireInspection(user.organizationId, inspectionId);
    const inspection = await this.prisma.inspection.findUnique({
      where: { id: inspectionId },
      // The type decides where this item is stored, not just what it asks.
      select: { finalizedAt: true, inspectionType: true },
    });
    if (inspection?.finalizedAt)
      throw new ApplicationError(
        409,
        'INSPECTION_FINALIZED',
        'The checklist cannot be changed after the inspection is finalized.',
      );

    // Scoped by inspection as well as id, so an area id from another inspection
    // cannot be written through this route.
    const area = await this.prisma.inspectionArea.findFirst({
      where: { id: areaId, inspectionId },
      select: { id: true, propertyAreaId: true },
    });
    if (!area)
      throw new ApplicationError(
        404,
        'INSPECTION_AREA_NOT_FOUND',
        'Inspection area was not found.',
      );

    /**
     * The item has to belong to *this* area, or to the organization.
     *
     * Without the first, the report would show an assessment against a room
     * nobody inspected.
     *
     * The second half was missing, and it is the same defect the technician
     * route carried until an HVAC technician could see sixty items and record
     * none of them: an organization-wide list is stored with a null area, so
     * matching on `propertyAreaId` alone answers 404 for every one of its items.
     * Reviewer-side scoring of an HVAC form has never worked, and the occupied
     * checklist added 2026-09-09 is stored the same way.
     */
    const item = await this.prisma.areaChecklistItem.findFirst({
      where: {
        id: itemId,
        archivedAt: null,
        ...(checklistItemsAreOrganizationWide(checklistKindFor(inspection?.inspectionType))
          ? { organizationId: user.organizationId, propertyAreaId: null }
          : { propertyAreaId: area.propertyAreaId }),
      },
      select: { id: true },
    });
    if (!item)
      throw new ApplicationError(
        404,
        'CHECKLIST_ITEM_NOT_FOUND',
        'That checklist item does not belong to this area.',
      );

    const values = {
      isClean: input.isClean ?? null,
      isUndamaged: input.isUndamaged ?? null,
      isWorking: input.isWorking ?? null,
      comment: input.comment?.trim() || null,
      videoTimestampSeconds: input.videoTimestampSeconds ?? null,
    };
    const response = await this.prisma.inspectionAreaChecklistResponse.upsert({
      where: {
        inspectionAreaId_checklistItemId: { inspectionAreaId: areaId, checklistItemId: itemId },
      },
      create: {
        organizationId: user.organizationId,
        inspectionAreaId: areaId,
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
    return {
      itemId: response.checklistItemId,
      isClean: response.isClean,
      isUndamaged: response.isUndamaged,
      isWorking: response.isWorking,
      comment: response.comment,
      recordedAt: response.recordedAt.toISOString(),
      videoTimestampSeconds: response.videoTimestampSeconds,
    };
  }

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
    /** Whether this visit owes a walkthrough at all: `inspectionRequiresAreaRecording`. */
    requiresRecording: boolean;
    recordings: number;
    photos: number;
    hasPrimaryRecording: boolean;
    processingFailed: boolean;
    processingPending: boolean;
    findings: number;
    unreviewedFindings: number;
    followUpFindings: number;
    /** A reviewer marked the area reviewed, and no evidence has arrived since. */
    reviewed: boolean;
  }): AreaReviewStatus {
    if (input.processingFailed) return 'FAILED';
    if (input.completionStatus === 'FAILED') return 'FAILED';
    // A reviewer's mark settles the area -- a skip they accepted, photographs
    // without a walkthrough they judged enough, an area with nothing wrong in
    // it -- but never over work still open: a finding awaiting a decision, a
    // requested re-inspection, a recording still being analysed. Without the
    // mark, an area with no findings could never count as reviewed at all.
    if (
      input.reviewed &&
      !input.followUpFindings &&
      !input.processingPending &&
      !input.unreviewedFindings
    )
      return 'REVIEWED';
    // Ahead of the evidence checks on purpose. A skipped area has no recording
    // by definition, so every downstream rule would report it as incomplete and
    // bury the fact that skipping was a decision with a reason attached.
    if (input.completionStatus === 'SKIPPED') return 'SKIPPED';
    if (!input.recordings && !input.photos) return 'NOT_STARTED';
    if (input.followUpFindings) return 'FOLLOW_UP_REQUIRED';
    if (input.processingPending) return 'ANALYSIS_PROCESSING';
    if (input.unreviewedFindings) return 'FINDINGS_NEED_REVIEW';
    // A required area without its walkthrough is incomplete even if photos and
    // decided findings exist — the primary recording is the mandated evidence.
    //
    // Only where a walkthrough is mandated. An occupied, back-to-market or HVAC
    // visit is walked in photographs, and the handset and `completeRoom` both
    // let the technician finish an area without filming. Asking for a video
    // here regardless painted every area of every such inspection "Evidence
    // incomplete", so the one status a reviewer scans for said nothing.
    if (input.isRequired && input.requiresRecording && !input.hasPrimaryRecording)
      return 'EVIDENCE_INCOMPLETE';
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
    const inspection = await this.requireInspection(user.organizationId, inspectionId);
    const attached = await this.prisma.inspectionArea.findMany({
      where: { inspectionId },
      // Walk order, then name and id: `inspectionOrder` is not unique, and two
      // areas sharing a value came back in whatever order the database chose,
      // so they could swap between two loads -- under the viewer that walks
      // from one area into the next, and in the reviewer's own list.
      orderBy: [
        { propertyArea: { inspectionOrder: 'asc' } },
        { propertyArea: { name: 'asc' } },
        { id: 'asc' },
      ],
      select: {
        id: true,
        completionStatus: true,
        skipReason: true,
        reviewedAt: true,
        reviewedById: true,
        propertyArea: {
          select: {
            id: true,
            name: true,
            // With the name, decides whether the area is the inspection's at all.
            source: true,
            environment: true,
            isRequired: true,
            floor: { select: { name: true } },
          },
        },
      },
    });
    /**
     * The areas the inspection inspects (`inspectedAreas`): not the job's
     * "AC filters" photo area, whose photographs the console shows beside the
     * filter change's answers instead.
     */
    const areas = inspectedAreas(inspection.inspectionType, attached);
    if (!attached.length)
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

    const kind = checklistKindFor(inspection.inspectionType);
    const organizationWide = checklistItemsAreOrganizationWide(kind);
    const requiresRecording = inspectionRequiresAreaRecording(inspection.inspectionType);
    const [
      media,
      photoGroups,
      findingGroups,
      summaryFindings,
      checklistItems,
      checklistResponses,
      reviewers,
    ] = await Promise.all([
        // Recordings are few per inspection; the rows carry the flags needed for
        // primary-presence and processing state in one pass.
        this.prisma.inspectionMedia.findMany({
          where: { inspectionId },
          select: {
            inspectionAreaId: true,
            recordingType: true,
            processingStatus: true,
            // Which failure a FAILED is; see `recordingState`.
            failureCode: true,
            createdAt: true,
          },
        }),
        // Photos can number in the hundreds, so they are counted, never listed.
        // `createdAt` is when the server received one: what a review mark is
        // compared against, since a photograph can be taken long before it
        // arrives.
        this.prisma.inspectionPhoto.groupBy({
          by: ['inspectionAreaId', 'captureType'],
          where: { inspectionId },
          _count: { _all: true },
          _max: { capturedAt: true, createdAt: true },
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
        /**
         * The checklist items this visit asks, chosen as `areaEvidence` chooses
         * them, so an area's "Checklist · 2/2" and its Condition tab count the
         * same rows.
         *
         * They used to be counted from different lists. The badge counted the
         * area's own room items whatever the visit, so an occupied room whose
         * two questions were both answered read "Checklist · 0/7" beside a tab
         * saying "2 of 2 assessed": the room list is not what an occupied visit
         * asks, and its answers are words, not the three axes the old count
         * looked for. One read for the whole inspection, filtered per area
         * below, keeps the summary at a constant number of queries.
         */
        this.prisma.areaChecklistItem.findMany({
          where: {
            ...(organizationWide
              ? { organizationId: user.organizationId, propertyAreaId: null }
              : { propertyAreaId: { in: areas.map((area) => area.propertyArea.id) } }),
            archivedAt: null,
            ...checklistKindWhere(kind),
          },
          select: { id: true, propertyAreaId: true, section: true, responseType: true },
        }),
        // Rows, not a grouped count: whether a row is an answer depends on its
        // item, which a `groupBy` over the responses cannot see.
        this.prisma.inspectionAreaChecklistResponse.findMany({
          where: { inspectionArea: { inspectionId } },
          select: {
            inspectionAreaId: true,
            checklistItemId: true,
            isClean: true,
            isUndamaged: true,
            isWorking: true,
            numericValue: true,
            textValue: true,
          },
        }),
        this.reviewerNames(areas.map((area) => area.reviewedById)),
      ]);

    const summaryAreas = new Set(summaryFindings.map((row) => row.propertyAreaId));
    const itemsById = new Map(checklistItems.map((item) => [item.id, item]));
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
      const review = reviewMark(
        area,
        latest([lastMediaAt, ...areaPhotos.map((row) => row._max.createdAt)]),
        reviewers,
      );
      // The same narrowing `areaEvidence` applies in its query: an
      // organization-wide list is asked whole, or one HVAC section of it.
      const section = checklistSectionFor(kind, area.propertyArea.name);
      const asked = checklistItems.filter(
        (item) =>
          (organizationWide || item.propertyAreaId === area.propertyArea.id) &&
          (!section || item.section === section),
      );
      const askedIds = new Set(asked.map((item) => item.id));
      // The Condition tab's rule (`isChecklistItemAssessed`): a reading, a line
      // of text or a chosen option is assessed once it is given; a status item
      // once any one axis is. A row where the technician answered only Clean
      // still says something about the room, and the printed reports contain
      // such partial rows; a comment alone does not count.
      const assessed = checklistResponses.filter((response) => {
        if (response.inspectionAreaId !== area.id || !askedIds.has(response.checklistItemId))
          return false;
        return itemsById.get(response.checklistItemId)?.responseType === 'STATUS'
          ? response.isClean !== null || response.isUndamaged !== null || response.isWorking !== null
          : response.numericValue !== null || Boolean(response.textValue);
      }).length;

      return {
        id: area.id,
        propertyAreaId: area.propertyArea.id,
        name: area.propertyArea.name,
        floorName: area.propertyArea.floor?.name ?? null,
        environment: area.propertyArea.environment,
        isRequired: area.propertyArea.isRequired,
        checklistItemCount: asked.length,
        checklistAssessedCount: assessed,
        completionStatus: area.completionStatus,
        // Only meaningful alongside a SKIPPED status, and null otherwise so the
        // console never prints a stale reason against an area that was resumed.
        skipReason: area.completionStatus === 'SKIPPED' ? area.skipReason : null,
        reviewStatus: this.reviewStatusFor({
          completionStatus: area.completionStatus,
          isRequired: area.propertyArea.isRequired,
          requiresRecording,
          recordings: areaMedia.length,
          photos,
          hasPrimaryRecording: areaMedia.some(
            (row) => row.recordingType === VideoRecordingType.PRIMARY_AREA,
          ),
          processingFailed: areaMedia.some((row) => recordingState(row) === 'FAILED'),
          processingPending: areaMedia.some(
            (row) => row.processingStatus === 'PENDING' || row.processingStatus === 'PROCESSING',
          ),
          findings,
          unreviewedFindings,
          followUpFindings,
          reviewed: Boolean(review?.current),
        }),
        review,
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

    // Every attached area, the hidden ones too: their photographs are filed,
    // not lost, and must not be reported as evidence with nowhere to go.
    const knownAreaIds = new Set(attached.map((area) => area.id));
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
    const inspection = await this.requireInspection(user.organizationId, inspectionId);
    const area = await this.prisma.inspectionArea.findFirst({
      // Scoped by inspection as well as id, so an area id from another
      // inspection cannot be read through this route.
      where: { id: areaId, inspectionId },
      select: {
        id: true,
        completionStatus: true,
        skipReason: true,
        technicianNote: true,
        reviewedAt: true,
        reviewedById: true,
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
      throw new ApplicationError(
        404,
        'INSPECTION_AREA_NOT_FOUND',
        'Inspection area was not found.',
      );

    const [recordings, photos, findings, summaryFinding, checklistItems, reviewers] =
      await Promise.all([
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
          // As Cloudflare measured it. Phone walkthroughs are portrait, and a
          // 16:9 frame showed them as a strip a third of its width.
          widthPx: true,
          heightPx: true,
          uploadStatus: true,
          processingStatus: true,
          // Which failure a FAILED is; see `recordingState`.
          failureCode: true,
          createdAt: true,
          // Where the technician tapped the shutter during the walkthrough.
          // Android cannot photograph while recording, so the shutter stores a
          // moment instead — until now those moments never reached the
          // reviewer, which made them useless.
          captureSummary: true,
          technician: { select: { displayName: true } },
          // The latest re-run of the AI analysis, if anybody asked for one.
          processingEvents: {
            where: { eventType: { in: REANALYSIS_EVENTS } },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { eventType: true, createdAt: true, payloadSummary: true },
          },
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
          captureTimeSource: true,
          // Received, and the fingerprint of the file as received: what a
          // reviewer needs to say where a photograph's time and bytes came from.
          createdAt: true,
          sha256: true,
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
          // What the AI asks the reviewer to check, and whose it leans to. Both
          // were written on every finding and never reached the screen.
          recommendedReview: true,
          possibleResponsibility: true,
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
      // Driven from the item list, not from the responses: an unassessed item
      // has no response row, and listing only what has been scored would hide
      // exactly the items still needing attention.
      this.prisma.areaChecklistItem.findMany({
        where: {
          /**
           * The HVAC and occupied checklists belong to the organization, not to
           * an area.
           *
           * HVAC asks the same sixty questions of every system in the
           * portfolio; the occupied list asks the same two of every room. Both
           * are stored once with a null area. Matching on the area alone
           * returned nothing for an HVAC inspection: the reviewer saw "this
           * area has no checklist items yet" about a form the technician had
           * just filled in.
           */
          ...(checklistItemsAreOrganizationWide(checklistKindFor(inspection.inspectionType))
            ? { organizationId: user.organizationId, propertyAreaId: null }
            : { propertyAreaId: area.propertyArea.id }),
          archivedAt: null,
          // A visit whose evidence is the answer asks nothing, and an empty
          // `in` matches no rows — the same result as skipping the query,
          // without the caller having to handle a different shape back.
          ...checklistKindWhere(checklistKindFor(inspection.inspectionType)),
          // An HVAC section shows the reviewer its own section, as the
          // technician was asked it.
          ...checklistSectionWhere(checklistKindFor(inspection.inspectionType), area.propertyArea.name),
        },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          label: true,
          section: true,
          responseType: true,
          unit: true,
          responses: {
            where: { inspectionAreaId: area.id },
            select: {
              isClean: true,
              isUndamaged: true,
              isWorking: true,
              comment: true,
              numericValue: true,
              textValue: true,
              recordedAt: true,
              videoTimestampSeconds: true,
            },
          },
        },
      }),
      this.reviewerNames([area.reviewedById]),
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
    /**
     * A photograph filed against a finding this list does not hold -- the
     * area's condition summary, which is kept apart from the findings -- is
     * grouped as if it had no finding.
     *
     * It used to fall into no group at all: counted in "Photos (n)" and in the
     * summary, and shown nowhere, so it could not be opened or reviewed.
     */
    const listed = (photo: (typeof photos)[number]) =>
      Boolean(photo.findingId && findingTitles.has(photo.findingId));
    const overview = photos.filter(
      (photo) => !listed(photo) && photo.captureType === PhotoCaptureType.AREA_OVERVIEW,
    );
    const supporting = photos.filter(
      (photo) => !listed(photo) && photo.captureType !== PhotoCaptureType.AREA_OVERVIEW,
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
      captureTimeSource: photo.captureTimeSource,
      receivedAt: photo.createdAt.toISOString(),
      sha256: photo.sha256,
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
    const review = reviewMark(
      area,
      latest([...recordings.map((row) => row.createdAt), ...photos.map((photo) => photo.createdAt)]),
      reviewers,
    );

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
          requiresRecording: inspectionRequiresAreaRecording(inspection.inspectionType),
          recordings: recordings.length,
          photos: photos.length,
          hasPrimaryRecording: recordings.some(
            (row) => row.recordingType === VideoRecordingType.PRIMARY_AREA,
          ),
          processingFailed: recordings.some((row) => recordingState(row) === 'FAILED'),
          processingPending: recordings.some(
            (row) => row.processingStatus === 'PENDING' || row.processingStatus === 'PROCESSING',
          ),
          findings: findings.length,
          unreviewedFindings,
          followUpFindings: findings.filter(
            (finding) => finding.reviewStatus === FindingReviewStatus.REINSPECTION_REQUESTED,
          ).length,
          reviewed: Boolean(review?.current),
        }),
        review,
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
        widthPx: recording.widthPx,
        heightPx: recording.heightPx,
        uploadStatus: recording.uploadStatus,
        processingStatus: recordingState(recording),
        technicianName: recording.technician.displayName,
        createdAt: recording.createdAt.toISOString(),
        thumbnailUrl: thumbnails[index],
        // Bounded by the recording length by the same helper the pipeline uses,
        // so a marker past the end never reaches the player as a dead chip.
        frameMarkersMs: readFrameMarkers(recording.captureSummary, recording.durationSeconds),
        analysisRun: reanalysisState(recording.processingEvents[0]),
        contentPath: `/api/v1/admin/media/${recording.id}/content`,
      })),
      photoGroups: groups,
      // Every item, assessed or not. `responses` is filtered to this inspection
      // area, so at most one row exists per item.
      checklist: checklistItems.map((item) => {
        const response = item.responses[0];
        return {
          itemId: item.id,
          label: item.label,
          isClean: response?.isClean ?? null,
          isUndamaged: response?.isUndamaged ?? null,
          isWorking: response?.isWorking ?? null,
          comment: response?.comment ?? null,
          section: item.section,
          responseType: item.responseType,
          unit: item.unit,
          // Decimal over the wire is a string; the console prints a number
          // beside a unit, and a quoted "18.50" reads as a mistake.
          numericValue: response?.numericValue == null ? null : Number(response.numericValue),
          textValue: response?.textValue ?? null,
          recordedAt: response?.recordedAt.toISOString() ?? null,
          videoTimestampSeconds: response?.videoTimestampSeconds ?? null,
        };
      }),
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
        recommendedReview: finding.recommendedReview,
        possibleResponsibility: finding.possibleResponsibility,
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

  /**
   * An administrator's "I have looked at this area", or taking it back.
   *
   * The review count used to move only when an area's findings were all
   * decided, so an area with nothing wrong in it -- no finding to decide --
   * could never count, and an occupied inspection read "0 of 20 reviewed" for
   * good. This is the reviewer saying so directly. It decides nothing about any
   * finding: an area with findings still awaiting a decision cannot be marked,
   * because the mark must never stand in for the human review of AI output.
   *
   * Refused once the inspection is finalized (`finalizedAt`, as the checklist
   * is), and for an area nobody recorded anything in and nobody skipped:
   * marking that reviewed would hide a gap rather than close one. Repeating the
   * same decision is a no-op, so a double click writes one audit row.
   */
  async setAreaReviewed(
    user: AuthenticatedUser,
    inspectionId: string,
    areaId: string,
    reviewed: boolean,
  ): Promise<{ areaId: string; review: AreaReviewMark | null }> {
    const inspection = await this.requireInspection(user.organizationId, inspectionId);
    if (inspection.finalizedAt)
      throw new ApplicationError(
        409,
        'INSPECTION_FINALIZED',
        'Areas cannot be marked reviewed after the inspection is finalized.',
      );
    const area = await this.prisma.inspectionArea.findFirst({
      where: { id: areaId, inspectionId },
      select: {
        id: true,
        completionStatus: true,
        reviewedAt: true,
        reviewedById: true,
        propertyArea: { select: { id: true, name: true } },
      },
    });
    if (!area)
      throw new ApplicationError(
        404,
        'INSPECTION_AREA_NOT_FOUND',
        'Inspection area was not found.',
      );

    const [media, photos, pending] = await Promise.all([
      this.prisma.inspectionMedia.aggregate({
        where: { inspectionAreaId: area.id },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      this.prisma.inspectionPhoto.aggregate({
        where: { inspectionAreaId: area.id },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      this.prisma.inspectionFinding.count({
        where: {
          inspectionId,
          propertyAreaId: area.propertyArea.id,
          reviewStatus: { in: UNREVIEWED },
          NOT: { ...ROOM_SUMMARY_WHERE },
        },
      }),
    ]);
    const lastReceivedAt = latest([media._max.createdAt, photos._max.createdAt]);

    if (reviewed) {
      if (!media._count._all && !photos._count._all && area.completionStatus !== 'SKIPPED')
        throw new ApplicationError(
          409,
          'AREA_NOT_INSPECTED',
          'Nothing was recorded in this area. Request evidence for it, or have the technician skip it with a reason.',
        );
      if (pending)
        throw new ApplicationError(
          409,
          'AREA_FINDINGS_PENDING',
          `Decide the ${pending} finding${pending === 1 ? '' : 's'} awaiting review in this area first.`,
        );
    }

    const names = await this.reviewerNames([area.reviewedById]);
    const standing = reviewMark(area, lastReceivedAt, names);
    // The same decision again changes nothing. A mark evidence has overtaken is
    // not the same decision: marking again is the reviewer catching up with it.
    if (reviewed ? standing?.current : !area.reviewedAt) return { areaId: area.id, review: standing };

    const at = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.inspectionArea.update({
        where: { id: area.id },
        data: reviewed
          ? { reviewedAt: at, reviewedById: user.id }
          : { reviewedAt: null, reviewedById: null },
      });
      // On the inspection rather than the area, so it reads in the inspection's
      // own activity beside finalization and the rest of its review.
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: reviewed ? 'AREA_REVIEWED' : 'AREA_REVIEW_WITHDRAWN',
          entityType: 'Inspection',
          entityId: inspectionId,
          metadata: { inspectionAreaId: area.id, areaName: area.propertyArea.name },
        },
      });
    });
    return {
      areaId: area.id,
      review: reviewed
        ? { at: at.toISOString(), byName: user.displayName ?? null, current: true }
        : null,
    };
  }

  /** Display names for the people who marked areas reviewed, in one read. */
  private async reviewerNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!wanted.length) return new Map();
    const people = await this.prisma.userProfile.findMany({
      where: { id: { in: wanted } },
      select: { id: true, displayName: true },
    });
    return new Map(people.map((person) => [person.id, person.displayName]));
  }

  private async requireInspection(organizationId: string, inspectionId: string) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId },
      // `inspectionType` for the checklist read in `areaEvidence`: an area
      // carries both item sets once it is marked as having a unit, and the
      // reviewer must be shown the one the technician was actually asked.
      // `finalizedAt` because a finalized inspection's review is closed.
      select: { id: true, inspectionType: true, finalizedAt: true },
    });
    if (!inspection)
      throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
    return inspection;
  }
}
