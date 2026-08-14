import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { FindingReviewStatus, type Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { withSystemTenant, withTenant } from '../database/tenant-context';
import { isAllowedPhotoWidth, resizeImage } from '../common/image-resizing';
import { resizedPhotoKeyFor } from '../common/object-storage';
import { PrismaService } from '../common/prisma.service';
import { InspectionMediaStorageService } from '../technician/inspection-media-storage.service';
import { MailService } from '../mail/mail.service';

const SHARE_LIFETIME_DAYS = 30;

const MAX_REPORT_PHOTOS = 300;

/**
 * Which photos a homeowner may see.
 *
 * What must not leak is *unreviewed AI output*: a photograph attached to a
 * finding is only safe once that finding is APPROVED, or the report publishes
 * a defect nobody signed off on. A photograph with no finding attached is the
 * technician's own record of the area and carries no such claim.
 *
 * This deliberately does **not** filter on `captureType`. It used to admit only
 * AREA_OVERVIEW, which meant the guided capture flow — which files its shots as
 * FINDING_CONTEXT — had every photograph silently dropped from the report: a
 * two-room inspection with twelve photographs published two. The capture type
 * describes how a photograph was framed, not whether it is fit to show, and
 * using it as a permission check hid evidence the report exists to present.
 */
const HOMEOWNER_VISIBLE_PHOTO: Prisma.InspectionPhotoWhereInput = {
  OR: [{ findingId: null }, { finding: { reviewStatus: FindingReviewStatus.APPROVED } }],
};

/**
 * How each inspection type is named on the printed report.
 *
 * The office's reports carry an "Inspection Template" line — the name of the
 * form the inspector worked from, not the enum. These are the equivalents;
 * `REPORT_TEMPLATE_LABEL_<TYPE>` overrides any of them for a deployment whose
 * wording differs, because this is the organisation's vocabulary rather than
 * ours to fix.
 */
const INSPECTION_TEMPLATE_LABEL: Record<string, string> = {
  MOVE_IN: process.env.REPORT_TEMPLATE_LABEL_MOVE_IN ?? 'Entry Inspection',
  MOVE_OUT: process.env.REPORT_TEMPLATE_LABEL_MOVE_OUT ?? 'Exit Inspection',
  OCCUPIED: process.env.REPORT_TEMPLATE_LABEL_OCCUPIED ?? 'Routine Inspection',
  BACK_TO_MARKET: process.env.REPORT_TEMPLATE_LABEL_BACK_TO_MARKET ?? 'Back to Market Inspection',
  HVAC: process.env.REPORT_TEMPLATE_LABEL_HVAC ?? 'HVAC Maintenance Inspection',
};

@Injectable()
export class ReportShareService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(MailService) private readonly mailer?: MailService,
    @Optional()
    @Inject(InspectionMediaStorageService)
    private readonly mediaStorage?: InspectionMediaStorageService,
  ) {}

  async createShare(user: AuthenticatedUser, inspectionId: string, recipientEmail?: string) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!inspection)
      throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SHARE_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
    const share = await this.prisma.$transaction(async (tx) => {
      const created = await tx.inspectionReportShare.create({
        data: {
          organizationId: user.organizationId,
          inspectionId,
          createdById: user.id,
          token,
          recipientEmail: recipientEmail?.trim().toLowerCase() || null,
          expiresAt,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'REPORT_SHARE_CREATED',
          entityType: 'Inspection',
          entityId: inspectionId,
          metadata: {
            shareId: created.id,
            recipientEmail: created.recipientEmail,
            expiresAt: created.expiresAt.toISOString(),
          },
        },
      });
      return created;
    });
    const delivery = share.recipientEmail
      ? await this.mailer?.sendReportShare({
          to: share.recipientEmail,
          reportUrl: this.reportUrl(share.token),
          expiresAt: share.expiresAt,
        })
      : undefined;
    return {
      ...this.mapShare(share),
      ...(share.recipientEmail
        ? { emailDeliveryStatus: delivery?.status ?? ('NOT_CONFIGURED' as const) }
        : {}),
    };
  }

  async listShares(user: AuthenticatedUser, inspectionId: string) {
    const shares = await this.prisma.inspectionReportShare.findMany({
      where: { inspectionId, organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return shares.map((share) => this.mapShare(share));
  }

  async revokeShare(user: AuthenticatedUser, shareId: string) {
    const share = await this.prisma.inspectionReportShare.findFirst({
      where: { id: shareId, organizationId: user.organizationId },
    });
    if (!share)
      throw new ApplicationError(404, 'REPORT_SHARE_NOT_FOUND', 'Report link was not found.');
    if (share.revokedAt) return this.mapShare(share);
    const updated = await this.prisma.$transaction(async (tx) => {
      const revoked = await tx.inspectionReportShare.update({
        where: { id: share.id },
        data: { revokedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'REPORT_SHARE_REVOKED',
          entityType: 'Inspection',
          entityId: share.inspectionId,
          metadata: { shareId: share.id },
        },
      });
      return revoked;
    });
    return this.mapShare(updated);
  }

  /**
   * Public, unauthenticated report for homeowners. Contains only reviewed
   * material: room completion, APPROVED findings, and photos that pass
   * HOMEOWNER_VISIBLE_PHOTO. Internal notes, technician identities, pending AI
   * output, and identifiers stay private.
   */
  async publicReport(token: string) {
    const share = await this.resolveShare(token);
    // `withTenant`, not `enterTenant`. The share lookup runs as the system
    // tenant, and `enterWith` inside that helper did not survive back into this
    // continuation — so no `set_config` ran, and every query below was made
    // under an unset tenant. That used to be harmless because the first
    // policies allowed a null tenant; once they were tightened to fail closed,
    // it silently turned every shared report into "This report is not
    // available." Wrapping the reads keeps the scope open across them.
    return withTenant(share.organizationId, () =>
      this.buildPublicReport(share.inspectionId, token, share.createdBy.displayName),
    );
  }

  private async buildPublicReport(inspectionId: string, token: string, issuedBy: string) {
    const inspection = await this.prisma.inspection.findUnique({
      where: { id: inspectionId },
      select: {
        inspectionType: true,
        status: true,
        scheduledAt: true,
        completedAt: true,
        nextInspectionAlert: true,
        maintenanceComments: true,
        generalComments: true,
        /**
         * Who carried out the inspection, for the report's "Inspector" line.
         *
         * Current assignments only, and all of them: the office's reports name
         * more than one person on a job, and a superseded assignment names
         * whoever *used* to hold it — printing that would credit the wrong
         * technician on a document a tenant may be shown.
         */
        assignments: {
          where: { isCurrent: true },
          orderBy: { assignedAt: 'asc' as const },
          select: { technician: { select: { displayName: true } } },
        },
        // Who signed the report off. Preferred over the link's creator: a
        // report can be shared more than once, by different people, and the
        // name on it should be whoever took responsibility for the content.
        finalizedBy: { select: { displayName: true } },
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
            completedAt: true,
            propertyArea: { select: { name: true, floor: { select: { name: true } } } },
            /**
             * The condition checklist as the technician scored it.
             *
             * Ordered by the item's own sortOrder so the report prints rows in
             * the sequence an administrator authored, which is the order the
             * office's existing reports use.
             *
             * Archived items are deliberately still included: the report is a
             * record of what was assessed at the time, and dropping a row
             * because someone later tidied the checklist would silently edit
             * history a tenant may already have been shown.
             */
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
                // `keywords` travels with the row so the report can attach the
                // finding that explains a failed axis. They already exist to
                // recognise the item in a transcript ("wall", "ceiling"), and
                // that is precisely the vocabulary an AI-authored finding
                // categorises itself with.
                checklistItem: { select: { id: true, label: true, keywords: true } },
              },
            },
            photos: {
              where: HOMEOWNER_VISIBLE_PHOTO,
              orderBy: [{ captureType: 'asc' }, { sequenceNumber: 'asc' }, { capturedAt: 'asc' }],
              take: MAX_REPORT_PHOTOS,
              select: {
                id: true,
                label: true,
                notes: true,
                capturedAt: true,
                width: true,
                height: true,
                // The caption the printed report uses. Every photograph in the
                // office's report is titled with the checklist item it
                // evidences, so the table states the verdict and the
                // photographs beneath prove it item by item.
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
            comparisonResult: true,
            baselineCondition: true,
            propertyArea: { select: { name: true } },
          },
        },
      },
    });
    if (!inspection)
      throw new ApplicationError(404, 'REPORT_NOT_AVAILABLE', 'This report is not available.');
    const building = inspection.propertywareBuilding;
    // Findings carry the catalog area id; rooms are per-inspection areas. Map
    // one to the other so the view model can group without guessing by name.
    const roomIdByPropertyArea = new Map(
      inspection.areas.map((area) => [area.propertyAreaId, area.id]),
    );
    return {
      brand: this.brand(),
      property: {
        name: building?.name ?? 'Property',
        addressLine1: building?.addressLine1 ?? '',
        unitName: inspection.propertywareUnit?.name ?? null,
        city: building?.city ?? '',
        state: building?.state ?? '',
        postalCode: building?.postalCode ?? '',
      },
      inspection: {
        type: inspection.inspectionType,
        status: inspection.status,
        scheduledAt: inspection.scheduledAt,
        completedAt: inspection.completedAt,
        // Null rather than a placeholder when nobody is assigned: the report
        // should not claim an inspector it does not have.
        /**
         * The office, then the field — the order the printed report uses.
         *
         * "Office" is whoever signed the report off, falling back to whoever
         * issued this link when it has not been finalized. A public report has
         * no viewer to ask, so the acting account has to be captured at issue
         * time rather than read at view time.
         *
         * Deduplicated: an administrator who is also the assigned technician
         * would otherwise be printed twice.
         */
        inspector:
          [
            ...new Set(
              [
                inspection.finalizedBy?.displayName ?? issuedBy,
                ...inspection.assignments.map((entry) => entry.technician.displayName),
              ].filter((name): name is string => Boolean(name?.trim())),
            ),
          ].join(' / ') || null,
        templateLabel: INSPECTION_TEMPLATE_LABEL[inspection.inspectionType] ?? null,
      },
      // The report's closing block. Nulls travel through as nulls so the
      // renderers can omit a heading rather than print one over nothing.
      closing: {
        nextInspectionAlert: inspection.nextInspectionAlert,
        maintenanceComments: inspection.maintenanceComments,
        generalComments: inspection.generalComments,
      },
      rooms: inspection.areas.map((area) => ({
        id: area.id,
        name: area.propertyArea.name,
        floorName: area.propertyArea.floor?.name ?? null,
        completionStatus: area.completionStatus,
        skipReason: area.skipReason,
        completedAt: area.completedAt,
        // Nulls are carried through rather than coerced: the report prints an
        // empty cell for an unassessed axis, and a false would claim a defect
        // the technician never recorded.
        checklist: area.checklistResponses.map((response) => ({
          id: response.checklistItem.id,
          label: response.checklistItem.label,
          keywords: response.checklistItem.keywords,
          isClean: response.isClean,
          isUndamaged: response.isUndamaged,
          isWorking: response.isWorking,
          comment: response.comment,
        })),
      })),
      findings: inspection.findings.map((finding) => ({
        id: finding.id,
        roomId: roomIdByPropertyArea.get(finding.propertyAreaId) ?? null,
        roomName: finding.propertyArea.name,
        title: finding.title,
        description: finding.description,
        category: finding.category,
        severity: finding.severity,
        comparisonResult: finding.comparisonResult,
        baselineCondition: finding.baselineCondition,
      })),
      photos: inspection.areas.flatMap((area) =>
        area.photos.map((photo) => ({
          id: photo.id,
          roomId: area.id,
          // The item name wins over free text: it is what the printed report
          // captions with, and a technician's ad-hoc label is the fallback for
          // a photograph that documents the room rather than one item.
          label: photo.checklistItem?.label ?? photo.label,
          checklistItem: photo.checklistItem?.label ?? null,
          notes: photo.notes,
          capturedAt: photo.capturedAt,
          width: photo.width,
          height: photo.height,
          contentPath: `/api/v1/reports/${encodeURIComponent(token)}/photos/${photo.id}`,
        })),
      ),
      generatedAt: new Date(),
    };
  }

  /**
   * Photo bytes for a shared report. The share token is the only credential, so
   * the photo must belong to that share's inspection *and* independently pass
   * the same visibility rule — a valid token for one inspection must never read
   * another's evidence, and must never reach an unapproved finding's photo.
   */
  async publicPhoto(token: string, photoId: string, width?: number) {
    const share = await this.resolveShare(token);
    return withTenant(share.organizationId, () =>
      this.loadPublicPhoto(share.inspectionId, photoId, width),
    );
  }

  private async loadPublicPhoto(inspectionId: string, photoId: string, width?: number) {
    if (!this.mediaStorage)
      throw new ApplicationError(
        503,
        'INSPECTION_MEDIA_STORAGE_NOT_CONFIGURED',
        'Inspection media storage is not configured.',
      );
    const photo = await this.prisma.inspectionPhoto.findFirst({
      where: { id: photoId, inspectionId, AND: HOMEOWNER_VISIBLE_PHOTO },
      select: { id: true, storageKey: true, mimeType: true },
    });
    if (!photo)
      throw new ApplicationError(404, 'REPORT_PHOTO_NOT_FOUND', 'This photo is not available.');
    if (width === undefined || !isAllowedPhotoWidth(width))
      return { bytes: await this.mediaStorage.get(photo.storageKey), mimeType: photo.mimeType };
    return { bytes: await this.resizedPhoto(photo.storageKey, width), mimeType: 'image/jpeg' };
  }

  /**
   * A width-limited copy, cached beside the original under a derived key so the
   * re-encode happens once per photo rather than once per view. A cache write
   * that fails is not an error — the caller still gets the resized bytes.
   */
  private async resizedPhoto(storageKey: string, width: number) {
    const variantKey = resizedPhotoKeyFor(storageKey, width);
    try {
      return await this.mediaStorage!.get(variantKey);
    } catch {
      // Not generated yet.
    }
    const original = await this.mediaStorage!.get(storageKey);
    const resized = await resizeImage(original, width);
    await this.mediaStorage!.putBytes(variantKey, resized, 'image/jpeg').catch(() => undefined);
    return resized;
  }

  /** Resolves a share token to its inspection, or 404s indistinguishably. */
  /**
   * Resolve a homeowner's share token, and adopt the organization it names.
   *
   * The token IS the credential here — `GET /reports/:token` carries no user —
   * so the lookup itself has no organization and runs as the system. Everything
   * after it does: the share tells us whose inspection this is, and the rest of
   * the request is scoped to that organization rather than left unscoped.
   *
   * `enterTenant` rather than wrapping the callers, so the two public methods
   * need no restructuring: it binds the rest of this request's async context.
   */
  private async resolveShare(token: string) {
    const share = await withSystemTenant(() =>
      this.prisma.inspectionReportShare.findUnique({
        where: { token },
        select: {
          inspectionId: true,
          organizationId: true,
          expiresAt: true,
          revokedAt: true,
          // Whoever issued this link — the logged-in account at the moment the
          // report went out. A public report has no viewer to ask.
          createdBy: { select: { displayName: true } },
        },
      }),
    );
    if (!share || share.revokedAt || share.expiresAt < new Date())
      throw new ApplicationError(
        404,
        'REPORT_NOT_AVAILABLE',
        'This report link is invalid, expired, or has been revoked.',
      );
    return share;
  }

  /** Letterhead. Deployment-level branding; every field is env-overridable. */
  private brand() {
    return {
      name: process.env.REPORT_BRAND_NAME ?? 'TexasRenters.com',
      addressLine1: process.env.REPORT_BRAND_ADDRESS_LINE1 ?? null,
      addressLine2: process.env.REPORT_BRAND_ADDRESS_LINE2 ?? null,
      phone: process.env.REPORT_BRAND_PHONE ?? null,
      email: process.env.REPORT_BRAND_EMAIL ?? null,
    };
  }

  private mapShare(share: {
    id: string;
    inspectionId: string;
    token: string;
    recipientEmail: string | null;
    expiresAt: Date;
    revokedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: share.id,
      inspectionId: share.inspectionId,
      token: share.token,
      sharePath: `/report/${share.token}`,
      recipientEmail: share.recipientEmail,
      expiresAt: share.expiresAt,
      revokedAt: share.revokedAt,
      createdAt: share.createdAt,
    };
  }

  private reportUrl(token: string) {
    const origin = (process.env.WEB_APP_ORIGIN ?? 'http://localhost:5454').replace(/\/$/, '');
    return `${origin}/report/${token}`;
  }
}
