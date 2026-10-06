/**
 * Move-in beside move-out, as one document.
 *
 * The console already shows a comparison as a list of verdicts. This is the
 * thing the office actually sends: both inspections laid out side by side, area
 * by area, with the evidence that justifies each verdict underneath it.
 *
 * **The pairing is not recomputed here.** `InspectionAreaComparison` already
 * records which move-in area each move-out area was matched to and the verdict
 * drawn on it. Re-matching would produce a second opinion that could quietly
 * disagree with the console's, so this reads the stored rows -- which the
 * callers bring up to date first (`ComparisonService.current`).
 *
 * The visibility rules are the inspection report's, deliberately: only APPROVED
 * findings, and only photographs that carry no unapproved finding. This document
 * is charge-relevant and is sent to owners and tenants by share link (the
 * office, 2026-10-06), so it must never be the place unconfirmed AI output first
 * appears. The verdicts follow the same rule: only a finding the office
 * confirmed moves one.
 *
 * Each room carries the item-by-item comparison the verdict was drawn from, as
 * it was when the comparison was generated. Reading the two checklists live
 * beside a stored verdict let them disagree: a checklist answer changed in
 * review after generation and the report printed "New since move-in: Walls"
 * over a table showing the walls sound.
 */
import { Inject, Injectable } from '@nestjs/common';
import type {
  ComparisonReport,
  ComparisonReportAreaSide,
  ComparisonReportItem,
} from '@texasrenters/shared';
import { FindingReviewStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import { ApplicationError } from '../common/errors';
import type { AuthenticatedUser } from '../common/auth';
import { inspectedAreas } from '../common/inspected-areas';
import { PrismaService } from '../common/prisma.service';
import { ROOM_SUMMARY_WHERE } from '../technician/room-summary';
import type { ComparedItem } from './comparison-items';

/** Bounded per inspection, so a photo-heavy pair cannot build an unbounded document. */
const MAX_REPORT_PHOTOS = 300;

/**
 * The same rule the shared inspection report uses.
 *
 * What must not leak is unreviewed AI output: a photograph attached to a finding
 * is only safe once that finding is APPROVED. A photograph with no finding is
 * the technician's own record of the area and carries no such claim. It does not
 * filter on `captureType` -- that describes framing, not fitness to publish, and
 * filtering on it once dropped ten of twelve photographs from a report.
 */
const REPORT_VISIBLE_PHOTO: Prisma.InspectionPhotoWhereInput = {
  OR: [{ findingId: null }, { finding: { reviewStatus: FindingReviewStatus.APPROVED } }],
};

/** How a photograph is addressed, which is all that differs between the two copies. */
type PhotoPath = (photoId: string) => string;

const adminPhotoPath: PhotoPath = (photoId) => `/api/v1/admin/photos/${photoId}/content`;

/**
 * The items stored on an area row by `ComparisonService.generate`, as the report
 * prints them. Their keywords stay behind: they exist to match findings to
 * items in the console, and say nothing to a reader.
 */
function storedItems(metadata: Prisma.JsonValue | null): ComparisonReportItem[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const items = (metadata as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return (items as ComparedItem[]).map((item) => ({
    itemId: item.itemId,
    label: item.label,
    moveIn: item.moveIn,
    moveOut: item.moveOut,
    change: item.change,
    cleaning: item.cleaning,
  }));
}

/** What the office confirmed from the recording as new, stored with the verdict. */
function storedFromRecording(metadata: Prisma.JsonValue | null): string[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const titles = (metadata as { fromRecording?: unknown }).fromRecording;
  return Array.isArray(titles) ? titles.filter((title): title is string => typeof title === 'string') : [];
}

const INSPECTION_TEMPLATE_LABEL: Record<string, string> = {
  MOVE_IN: process.env.REPORT_TEMPLATE_LABEL_MOVE_IN ?? 'Entry Inspection',
  MOVE_OUT: process.env.REPORT_TEMPLATE_LABEL_MOVE_OUT ?? 'Exit Inspection',
};

@Injectable()
export class ComparisonReportService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The console's copy: photographs come from the authenticated admin route. */
  async report(user: AuthenticatedUser, moveOutInspectionId: string): Promise<ComparisonReport> {
    return this.build(user.organizationId, moveOutInspectionId, adminPhotoPath);
  }

  /**
   * The shared copy, for the link an owner or tenant opens.
   *
   * Photographs are addressed through the share token, which is the viewer's
   * only credential -- the route the shared inspection report uses, so an
   * expired or revoked link fails identically for the page and its images.
   */
  async reportForShare(
    organizationId: string,
    moveOutInspectionId: string,
    token: string,
  ): Promise<ComparisonReport> {
    return this.build(
      organizationId,
      moveOutInspectionId,
      (photoId) => `/api/v1/reports/${encodeURIComponent(token)}/photos/${photoId}`,
    );
  }

  private async build(
    organizationId: string,
    moveOutInspectionId: string,
    photoPath: PhotoPath,
  ): Promise<ComparisonReport> {
    const comparison = await this.prisma.inspectionComparison.findFirst({
      where: { moveOutInspectionId, organizationId },
      include: {
        areaComparisons: {
          // Position, because `createdAt` cannot order these: one `createMany`
          // in one transaction gives every row the same `CURRENT_TIMESTAMP`, so
          // ordering on it is a tie the database may break differently on every
          // read -- which on this document meant the areas shuffled between
          // loads of the same comparison.
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    // Scoped by organization as well as inspection, so a comparison belonging to
    // another organization reads as absent rather than forbidden.
    if (!comparison)
      throw new ApplicationError(
        404,
        'COMPARISON_NOT_FOUND',
        'No comparison has been generated for this inspection yet.',
      );

    const [moveIn, moveOut] = await Promise.all([
      this.loadSide(comparison.moveInInspectionId, photoPath),
      this.loadSide(comparison.moveOutInspectionId, photoPath),
    ]);

    const areas = comparison.areaComparisons.map((row) => ({
      id: row.id,
      areaName: row.areaName,
      floorName: row.floorName,
      classification: row.classification,
      matchMethod: row.matchMethod,
      matchConfidence: row.matchConfidence,
      // Nullable in the table; a renderer should not have to null-check a caption.
      summary: row.summary ?? '',
      items: storedItems(row.metadata),
      fromRecording: storedFromRecording(row.metadata),
      // Null on either side is meaningful: an area documented at move-in and
      // never revisited, or one that only exists at move-out. Those rows are
      // the point of the document, so they are carried rather than dropped.
      moveIn: row.moveInPropertyAreaId
        ? (moveIn.areas.get(row.moveInPropertyAreaId) ?? null)
        : null,
      moveOut: row.moveOutPropertyAreaId
        ? (moveOut.areas.get(row.moveOutPropertyAreaId) ?? null)
        : null,
    }));

    return {
      brand: this.brand(),
      // Both inspections are on the same property, so either side describes it.
      property: moveOut.property,
      comparison: {
        id: comparison.id,
        version: comparison.version,
        overallCondition: comparison.overallCondition,
        summary: comparison.summary ?? '',
        generatedAt: comparison.generatedAt.toISOString(),
      },
      moveIn: moveIn.inspection,
      moveOut: moveOut.inspection,
      areas,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * One inspection's header and its areas, keyed by catalog area id.
   *
   * Keyed by `propertyAreaId` rather than the `InspectionArea` id because that
   * is what `InspectionAreaComparison` stores on each side, and it is the only
   * identifier the two inspections share.
   */
  private async loadSide(inspectionId: string, photoPath: PhotoPath) {
    const inspection = await this.prisma.inspection.findUnique({
      where: { id: inspectionId },
      select: {
        id: true,
        inspectionType: true,
        status: true,
        scheduledAt: true,
        completedAt: true,
        // Current assignments only, and all of them: a job can carry more than
        // one technician, and a superseded assignment names whoever *used* to
        // hold it -- which would credit the wrong person on a charge document.
        assignments: {
          where: { isCurrent: true },
          orderBy: { assignedAt: 'asc' as const },
          select: { technician: { select: { displayName: true } } },
        },
        propertywareUnit: { select: { name: true } },
        propertywareBuilding: {
          select: { name: true, addressLine1: true, city: true, state: true, postalCode: true },
        },
        areas: {
          orderBy: { propertyArea: { inspectionOrder: 'asc' } },
          take: 100,
          select: {
            id: true,
            propertyAreaId: true,
            completionStatus: true,
            skipReason: true,
            // source with the name: whether the area is the inspection's at all.
            propertyArea: { select: { name: true, source: true, floor: { select: { name: true } } } },
            checklistResponses: {
              orderBy: [
                { checklistItem: { sortOrder: 'asc' as const } },
                { checklistItem: { label: 'asc' as const } },
              ],
              select: {
                isClean: true,
                isUndamaged: true,
                isWorking: true,
                comment: true,
                checklistItem: { select: { id: true, label: true, keywords: true } },
              },
            },
            photos: {
              where: REPORT_VISIBLE_PHOTO,
              orderBy: [{ captureType: 'asc' }, { sequenceNumber: 'asc' }, { capturedAt: 'asc' }],
              take: MAX_REPORT_PHOTOS,
              select: {
                id: true,
                label: true,
                notes: true,
                capturedAt: true,
                captureTimeSource: true,
                width: true,
                height: true,
                checklistItem: { select: { label: true } },
              },
            },
          },
        },
        // The room's condition summary is context for reviewers, never a
        // finding: it is not printed whatever its status.
        findings: {
          where: { reviewStatus: FindingReviewStatus.APPROVED, NOT: { ...ROOM_SUMMARY_WHERE } },
          orderBy: { createdAt: 'asc' },
          take: 200,
          select: {
            id: true,
            propertyAreaId: true,
            title: true,
            description: true,
            category: true,
            severity: true,
          },
        },
      },
    });
    if (!inspection)
      throw new ApplicationError(
        404,
        'COMPARISON_INSPECTION_NOT_FOUND',
        'One of the inspections in this comparison is no longer available.',
      );

    const findingsByArea = new Map<string, ComparisonReportAreaSide['findings']>();
    for (const finding of inspection.findings) {
      const list = findingsByArea.get(finding.propertyAreaId) ?? [];
      list.push({
        id: finding.id,
        title: finding.title,
        description: finding.description,
        category: finding.category,
        severity: finding.severity,
      });
      findingsByArea.set(finding.propertyAreaId, list);
    }

    const areas = new Map<string, ComparisonReportAreaSide>();
    // The rooms it inspected, as the comparison paired them (`inspectedAreas`).
    for (const area of inspectedAreas(inspection.inspectionType, inspection.areas)) {
      areas.set(area.propertyAreaId, {
        roomId: area.id,
        name: area.propertyArea.name,
        floorName: area.propertyArea.floor?.name ?? null,
        completionStatus: area.completionStatus,
        skipReason: area.skipReason,
        checklist: area.checklistResponses.map((response) => ({
          id: response.checklistItem.id,
          label: response.checklistItem.label,
          keywords: response.checklistItem.keywords,
          // Tri-state throughout: null is "not assessed", and a renderer must
          // show it as blank. Printing "No" for an unassessed row would publish
          // a defect nobody observed.
          isClean: response.isClean,
          isUndamaged: response.isUndamaged,
          isWorking: response.isWorking,
          comment: response.comment,
        })),
        findings: findingsByArea.get(area.propertyAreaId) ?? [],
        photos: area.photos.map((photo) => ({
          id: photo.id,
          roomId: area.id,
          label: photo.label ?? photo.checklistItem?.label ?? null,
          checklistItem: photo.checklistItem?.label ?? null,
          notes: photo.notes,
          capturedAt: photo.capturedAt.toISOString(),
          captureTimeSource: photo.captureTimeSource,
          width: photo.width,
          height: photo.height,
          // The one field that differs between readers: the console's
          // authenticated route, or the share token's.
          contentPath: photoPath(photo.id),
        })),
      });
    }

    const building = inspection.propertywareBuilding;
    return {
      inspection: {
        inspectionId: inspection.id,
        type: inspection.inspectionType,
        status: inspection.status,
        scheduledAt: inspection.scheduledAt.toISOString(),
        completedAt: inspection.completedAt?.toISOString() ?? null,
        inspector:
          inspection.assignments.map((a) => a.technician.displayName).join(', ') || null,
        templateLabel: INSPECTION_TEMPLATE_LABEL[inspection.inspectionType] ?? null,
      },
      property: {
        name: building?.name ?? 'Property',
        addressLine1: building?.addressLine1 ?? '',
        unitName: inspection.propertywareUnit?.name ?? null,
        city: building?.city ?? '',
        state: building?.state ?? '',
        postalCode: building?.postalCode ?? '',
      },
      areas,
    };
  }

  private brand() {
    return {
      name: process.env.REPORT_BRAND_NAME ?? 'TexasRenters.com',
      addressLine1: process.env.REPORT_BRAND_ADDRESS_LINE1 ?? null,
      addressLine2: process.env.REPORT_BRAND_ADDRESS_LINE2 ?? null,
      phone: process.env.REPORT_BRAND_PHONE ?? null,
      email: process.env.REPORT_BRAND_EMAIL ?? null,
    };
  }
}
