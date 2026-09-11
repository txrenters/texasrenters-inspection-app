/**
 * Move-in beside move-out, as one document.
 *
 * The console already shows a comparison as a list of verdicts. This is the
 * thing the office actually sends: both inspections laid out side by side, area
 * by area, with the evidence that justifies each verdict underneath it.
 *
 * **The pairing is not recomputed here.** `InspectionAreaComparison` already
 * records which move-in area each move-out area was matched to, how confidently,
 * and what a reviewer decided about it. Re-matching would produce a second
 * opinion that could quietly disagree with the page the reviewer approved, so
 * this reads the stored rows and prints the verdict that was actually reviewed.
 *
 * The visibility rules are the inspection report's, deliberately: only APPROVED
 * findings, and only photographs that carry no unapproved finding. This document
 * is charge-relevant and may be shown to a tenant once the share link exists, so
 * it must never be the place unreviewed AI output first appears.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { ComparisonReport, ComparisonReportAreaSide } from '@texasrenters/shared';
import { FindingReviewStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import { ApplicationError } from '../common/errors';
import type { AuthenticatedUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';

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

const INSPECTION_TEMPLATE_LABEL: Record<string, string> = {
  MOVE_IN: process.env.REPORT_TEMPLATE_LABEL_MOVE_IN ?? 'Entry Inspection',
  MOVE_OUT: process.env.REPORT_TEMPLATE_LABEL_MOVE_OUT ?? 'Exit Inspection',
};

@Injectable()
export class ComparisonReportService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async report(user: AuthenticatedUser, moveOutInspectionId: string): Promise<ComparisonReport> {
    const comparison = await this.prisma.inspectionComparison.findFirst({
      where: { moveOutInspectionId, organizationId: user.organizationId },
      include: { areaComparisons: { orderBy: { createdAt: 'asc' } } },
    });
    // Scoped by organization as well as inspection, so a comparison belonging to
    // another organization reads as absent rather than forbidden.
    if (!comparison)
      throw new ApplicationError(
        404,
        'COMPARISON_NOT_FOUND',
        'No comparison has been generated for this inspection yet.',
      );

    const [moveIn, moveOut, reviewer] = await Promise.all([
      this.loadSide(comparison.moveInInspectionId),
      this.loadSide(comparison.moveOutInspectionId),
      comparison.reviewedById
        ? this.prisma.userProfile.findUnique({
            where: { id: comparison.reviewedById },
            select: { displayName: true },
          })
        : Promise.resolve(null),
    ]);

    const areas = comparison.areaComparisons.map((row) => ({
      id: row.id,
      areaName: row.areaName,
      floorName: row.floorName,
      classification: row.classification,
      originalClassification: row.originalClassification,
      overrideReason: row.overrideReason,
      matchMethod: row.matchMethod,
      matchConfidence: row.matchConfidence,
      requiresReview: row.requiresReview,
      // Nullable in the table; a renderer should not have to null-check a caption.
      summary: row.summary ?? '',
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
        status: comparison.status,
        version: comparison.version,
        overallCondition: comparison.overallCondition,
        requiresReviewCount: comparison.requiresReviewCount,
        summary: comparison.summary ?? '',
        generatedAt: comparison.generatedAt.toISOString(),
        reviewedByName: reviewer?.displayName ?? null,
        reviewedAt: comparison.reviewedAt?.toISOString() ?? null,
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
  private async loadSide(inspectionId: string) {
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
            propertyArea: { select: { name: true, floor: { select: { name: true } } } },
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
                width: true,
                height: true,
                checklistItem: { select: { label: true } },
              },
            },
          },
        },
        findings: {
          where: { reviewStatus: FindingReviewStatus.APPROVED },
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
    for (const area of inspection.areas) {
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
          width: photo.width,
          height: photo.height,
          // The authenticated console route. This is the only field a share-link
          // version of this document would need to change.
          contentPath: `/api/v1/admin/photos/${photo.id}/content`,
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
