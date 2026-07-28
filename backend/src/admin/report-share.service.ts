import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { FindingReviewStatus, PhotoCaptureType, type Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
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
 * An area overview with no finding attached is neutral evidence. Anything tied
 * to a finding is only safe once that finding is APPROVED — otherwise the
 * report would leak pending or rejected AI output. Both clauses are needed:
 * `findingId: null` alone would re-expose a detail photo if its rejected
 * finding were ever deleted (the relation is onDelete: SetNull).
 */
const HOMEOWNER_VISIBLE_PHOTO: Prisma.InspectionPhotoWhereInput = {
  OR: [
    { captureType: PhotoCaptureType.AREA_OVERVIEW, findingId: null },
    { finding: { reviewStatus: FindingReviewStatus.APPROVED } },
  ],
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
    const inspectionId = await this.resolveShare(token);
    const inspection = await this.prisma.inspection.findUnique({
      where: { id: inspectionId },
      select: {
        inspectionType: true,
        status: true,
        scheduledAt: true,
        completedAt: true,
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
      },
      rooms: inspection.areas.map((area) => ({
        id: area.id,
        name: area.propertyArea.name,
        floorName: area.propertyArea.floor?.name ?? null,
        completionStatus: area.completionStatus,
        skipReason: area.skipReason,
        completedAt: area.completedAt,
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
          label: photo.label,
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
    const inspectionId = await this.resolveShare(token);
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
  private async resolveShare(token: string) {
    const share = await this.prisma.inspectionReportShare.findUnique({
      where: { token },
      select: { inspectionId: true, expiresAt: true, revokedAt: true },
    });
    if (!share || share.revokedAt || share.expiresAt < new Date())
      throw new ApplicationError(
        404,
        'REPORT_NOT_AVAILABLE',
        'This report link is invalid, expired, or has been revoked.',
      );
    return share.inspectionId;
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
