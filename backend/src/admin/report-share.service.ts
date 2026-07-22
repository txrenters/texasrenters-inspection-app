import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { FindingReviewStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

const SHARE_LIFETIME_DAYS = 30;

@Injectable()
export class ReportShareService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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
    return this.mapShare(share);
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
   * material: room completion and APPROVED findings. Internal notes,
   * technician identities, pending AI output, and identifiers stay private.
   */
  async publicReport(token: string) {
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
    const inspection = await this.prisma.inspection.findUnique({
      where: { id: share.inspectionId },
      select: {
        inspectionType: true,
        status: true,
        scheduledAt: true,
        completedAt: true,
        propertywareBuilding: {
          select: { name: true, addressLine1: true, city: true, state: true, postalCode: true },
        },
        areas: {
          orderBy: { propertyArea: { inspectionOrder: 'asc' } },
          take: 100,
          select: {
            id: true,
            completionStatus: true,
            skipReason: true,
            completedAt: true,
            propertyArea: { select: { name: true, floor: { select: { name: true } } } },
          },
        },
        findings: {
          where: { reviewStatus: FindingReviewStatus.APPROVED },
          orderBy: { createdAt: 'asc' },
          take: 200,
          select: {
            id: true,
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
    return {
      property: {
        name: building?.name ?? 'Property',
        addressLine1: building?.addressLine1 ?? '',
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
        roomName: finding.propertyArea.name,
        title: finding.title,
        description: finding.description,
        category: finding.category,
        severity: finding.severity,
        comparisonResult: finding.comparisonResult,
        baselineCondition: finding.baselineCondition,
      })),
      generatedAt: new Date(),
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
}
