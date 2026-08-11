import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  EvidenceRequestStatus,
  FindingReviewStatus,
  InspectionStatus,
  InspectionType,
  MediaProcessingStatus,
  Prisma,
  PropertyAreaStatus,
  UserRole,
  VideoRecordingType,
} from '@prisma/client';

import {
  LEASE_EXPIRING_SOON_DAYS,
  daysUntilLeaseEnd,
  leaseExpiryStatus,
} from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { CacheInvalidationService } from '../cache/cache-invalidation.service';
import { CacheService, type CacheReadOptions } from '../cache/cache.service';
import { ApplicationError } from '../common/errors';
import { isAllowedPhotoWidth, resizeImage } from '../common/image-resizing';
import { resizedPhotoKeyFor, thumbnailKeyFor } from '../common/object-storage';
import { PrismaService } from '../common/prisma.service';
import { MailService } from '../mail/mail.service';
// A pure function, not the service: the panel needs Stream's definition of
// "ready" without AdminModule depending on MediaModule.
import {
  CloudflareStreamService,
  cloudflareStreamReadiness,
} from '../media/cloudflare-stream.service';
import { TechnicianEventsGateway } from '../realtime/technician-events.gateway';
import { InspectionMediaStorageService } from '../technician/inspection-media-storage.service';
import { ROOM_SUMMARY_WHERE } from '../technician/media-processing.service';
import type {
  AdminFindingsQueryDto,
  AssignmentDto,
  AssignmentListQueryDto,
  AuditListQueryDto,
  CreateAdminInspectionDto,
  CreateEvidenceRequestDto,
  FinalizeInspectionDto,
  InspectionFollowUpDto,
  InspectionListQueryDto,
  InspectionTbdDto,
  InspectionUnderReviewDto,
  LeaseListQueryDto,
  MergeInspectionAreasDto,
  PaginationDto,
  PortfolioListQueryDto,
  PropertyListQueryDto,
  ReopenInspectionDto,
  TechnicianListQueryDto,
  TechnicianStatusDto,
  UnassignDto,
  UnitListQueryDto,
  UpdateAdminInspectionDto,
} from './admin.dto';

const ACTIVE_INSPECTION_STATUSES: InspectionStatus[] = [
  InspectionStatus.SCHEDULED,
  InspectionStatus.IN_PROGRESS,
  InspectionStatus.TECHNICIAN_SUBMITTED,
  InspectionStatus.PROCESSING,
  InspectionStatus.REVIEW_REQUIRED,
  InspectionStatus.UNDER_REVIEW,
  InspectionStatus.TBD,
  InspectionStatus.FOLLOW_UP_REQUIRED,
];

// An inspection can no longer transition once finalized or cancelled.
const FROZEN_INSPECTION_STATUSES: InspectionStatus[] = [
  InspectionStatus.COMPLETED,
  InspectionStatus.CANCELLED,
];

/**
 * Statuses an inspection can be reopened from.
 *
 * Everything the technician has already handed over, plus COMPLETED — reopening
 * a finalized inspection is the main reason this exists, so it deliberately
 * reaches past FROZEN_INSPECTION_STATUSES rather than using assertReviewable.
 *
 * SCHEDULED and IN_PROGRESS are absent because there is nothing to reopen, and
 * CANCELLED because a cancelled inspection is closed rather than finished —
 * reviving one should be a new inspection, not a status flip.
 */
/**
 * What a request looks like to both sides.
 *
 * The area's name travels with it so the technician's list can say "Kitchen"
 * without a second query, and the reviewer's list does not have to re-join
 * areas it already has.
 */
const EVIDENCE_REQUEST_SELECT = {
  id: true,
  inspectionId: true,
  inspectionAreaId: true,
  checklistItemIds: true,
  note: true,
  status: true,
  requestedAt: true,
  resolvedAt: true,
  inspectionArea: { select: { propertyArea: { select: { name: true } } } },
} satisfies Prisma.AreaEvidenceRequestSelect;

const REOPENABLE_INSPECTION_STATUSES: InspectionStatus[] = [
  InspectionStatus.TECHNICIAN_SUBMITTED,
  InspectionStatus.PROCESSING,
  InspectionStatus.REVIEW_REQUIRED,
  InspectionStatus.UNDER_REVIEW,
  InspectionStatus.TBD,
  InspectionStatus.FOLLOW_UP_REQUIRED,
  InspectionStatus.COMPLETED,
];

// Finalization / TBD / follow-up review actions are only valid after the
// technician has submitted the inspection.
const REVIEWABLE_INSPECTION_STATUSES: InspectionStatus[] = [
  InspectionStatus.TECHNICIAN_SUBMITTED,
  InspectionStatus.PROCESSING,
  InspectionStatus.REVIEW_REQUIRED,
  InspectionStatus.UNDER_REVIEW,
  InspectionStatus.TBD,
  InspectionStatus.FOLLOW_UP_REQUIRED,
];

const ADMIN_TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5_000,
  timeout: 15_000,
} as const;

/**
 * Ceiling on one bulk-delete request.
 *
 * Each inspection is its own transaction, so this is not a transaction-size
 * limit — it bounds how long a single HTTP request can hold a worker while it
 * walks Cloudflare Stream and object storage for every recording and photo.
 * Fifty is comfortably more than a test-data sweep needs and well short of a
 * request that would look hung.
 */
const MAX_BULK_DELETE = 50;

/**
 * Restricts properties to those whose portfolio is active, without hiding the
 * ones that have no portfolio at all.
 *
 * Propertyware genuinely returns buildings with no portfolio assigned. Filtering
 * on the relation alone would drop every one of them, because an absent
 * relation cannot satisfy `isActive` — so an unassigned property would vanish
 * from the app entirely rather than merely lack an ownership grouping. Nested
 * in `AND` so it composes with a search `OR` on the same query.
 */
const PORTFOLIO_VISIBLE = {
  AND: [{ OR: [{ portfolioId: null }, { portfolio: { isActive: true } }] }],
} satisfies Prisma.PropertywareBuildingWhereInput;

/**
 * Readiness of the object storage that inspection **photos** are written to.
 *
 * Photos, not room video. Video goes to Cloudflare Stream and is reported
 * separately — this bucket holds the technician's stills and the resized
 * variants generated from them.
 *
 * Follows `INSPECTION_MEDIA_STORAGE_PROVIDER` rather than assuming one vendor,
 * so the panel keeps telling the truth if the backend is pointed elsewhere.
 * `local` is deliberately reported as degraded: it works, but the container disk
 * is ephemeral, so evidence stored there is lost on the next redeploy.
 */
function mediaStorageReadiness(
  status: (configured: boolean, ready?: boolean) => 'READY' | 'DEGRADED' | 'NOT_CONFIGURED',
) {
  const provider = process.env.INSPECTION_MEDIA_STORAGE_PROVIDER;
  if (provider === 'r2') {
    const configured = Boolean(
      process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY,
    );
    return {
      provider: 'Cloudflare R2 (photos)',
      status: status(configured),
      detail: configured
        ? `Inspection photo bucket: ${process.env.INSPECTION_MEDIA_BUCKET ?? 'default'}`
        : 'Inspection photo upload will fail until R2 credentials are set.',
    };
  }
  return {
    provider: 'Inspection photo storage',
    status: status(true, false),
    detail: 'Using local container disk — evidence is lost on redeploy. Development only.',
  };
}

@Injectable()
export class AdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(TechnicianEventsGateway)
    private readonly technicianEvents?: TechnicianEventsGateway,
    @Optional()
    @Inject(CacheService)
    private readonly cache?: CacheService,
    @Optional()
    @Inject(CacheInvalidationService)
    private readonly cacheInvalidation?: CacheInvalidationService,
    @Optional()
    @Inject(InspectionMediaStorageService)
    private readonly mediaStorage?: InspectionMediaStorageService,
    @Optional() @Inject(MailService) private readonly mailer?: MailService,
    @Optional()
    @Inject(CloudflareStreamService)
    private readonly stream?: CloudflareStreamService,
  ) {}

  async profile(user: AuthenticatedUser) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        displayName: true,
        isActive: true,
        createdAt: true,
        memberships: {
          where: { organizationId: user.organizationId },
          select: { role: true, organization: { select: { id: true, name: true } } },
        },
      },
    });
    if (!profile?.isActive)
      throw new ApplicationError(403, 'ADMIN_ACCOUNT_DISABLED', 'Account is disabled.');
    // Effective permissions come from the authenticated principal. Apart from
    // the protected SYSTEM_ADMIN bootstrap override, they are derived only from
    // administrator-created custom roles.
    return { ...profile, permissions: user.permissions };
  }

  async dashboard(user: AuthenticatedUser) {
    return this.cacheRead({
      resource: 'dashboard',
      scope: user.organizationId,
      query: { view: 'admin', roles: [...user.roles].sort() },
      loader: () => this.loadDashboard(user),
    });
  }

  private async loadDashboard(user: AuthenticatedUser) {
    const organizationId = user.organizationId;
    // Keep concurrency below the small session-pool limit used by the deployed API.
    // Eleven simultaneous reads can exhaust that pool and turn a dashboard load into HTTP 500.
    const [portfolios, properties, units, leases] = await Promise.all([
      this.prisma.propertywarePortfolio.count({ where: { organizationId, isActive: true } }),
      this.prisma.propertywareBuilding.count({ where: { organizationId, isActive: true } }),
      this.prisma.propertywareUnit.count({ where: { organizationId, isActive: true } }),
      this.prisma.propertywareLease.count({ where: { organizationId, isActive: true } }),
    ]);
    const [unassigned, assigned, inProgress, completed] = await Promise.all([
      this.prisma.inspection.count({
        where: {
          organizationId,
          status: { in: ACTIVE_INSPECTION_STATUSES },
          assignments: { none: { isCurrent: true } },
        },
      }),
      this.prisma.inspection.count({
        where: { organizationId, assignments: { some: { isCurrent: true } } },
      }),
      this.prisma.inspection.count({
        where: { organizationId, status: InspectionStatus.IN_PROGRESS },
      }),
      this.prisma.inspection.count({
        where: { organizationId, status: InspectionStatus.COMPLETED },
      }),
    ]);
    const [technicians, lastSync, recentErrors] = await Promise.all([
      this.prisma.userProfile.count({
        where: {
          isActive: true,
          memberships: { some: { organizationId, role: UserRole.INSPECTION_TECHNICIAN } },
        },
      }),
      this.prisma.propertywareSyncRun.findFirst({
        where: { organizationId, status: { in: ['COMPLETED', 'COMPLETED_WITH_ERRORS'] } },
        orderBy: { completedAt: 'desc' },
        select: {
          id: true,
          syncType: true,
          status: true,
          startedAt: true,
          completedAt: true,
          recordsFetched: true,
          recordsCreated: true,
          recordsUpdated: true,
          recordsUnchanged: true,
          recordsDeactivated: true,
          recordsFailed: true,
          pagesFetched: true,
          warnings: true,
        },
      }),
      this.prisma.propertywareSyncError.findMany({
        where: { syncRun: { organizationId }, resolvedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          entityType: true,
          errorCode: true,
          sanitizedMessage: true,
          createdAt: true,
        },
      }),
    ]);
    return {
      metrics: {
        portfolios,
        properties,
        units,
        leases,
        unassigned,
        assigned,
        inProgress,
        completed,
        technicians,
      },
      lastSync,
      recentErrors,
      providerReadiness: this.providerStatuses(),
    };
  }

  async portfolios(user: AuthenticatedUser, query: PortfolioListQueryDto) {
    return this.cacheRead({
      resource: 'portfolios',
      scope: user.organizationId,
      query,
      loader: () => this.loadPortfolios(user, query),
    });
  }

  private async loadPortfolios(user: AuthenticatedUser, query: PortfolioListQueryDto) {
    const where: Prisma.PropertywarePortfolioWhereInput = {
      organizationId: user.organizationId,
      isActive: true,
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { abbreviation: { contains: query.search, mode: 'insensitive' } },
              { externalId: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.propertywarePortfolio.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          externalId: true,
          name: true,
          abbreviation: true,
          lastSyncedAt: true,
        },
      }),
      this.prisma.propertywarePortfolio.count({ where }),
    ]);
    return this.page(items, total, query);
  }

  async properties(user: AuthenticatedUser, query: PropertyListQueryDto) {
    return this.cacheRead({
      resource: query.search ? 'propertySearch' : 'properties',
      scope: user.organizationId,
      query,
      loader: () => this.loadProperties(user, query),
    });
  }

  private async loadProperties(user: AuthenticatedUser, query: PropertyListQueryDto) {
    const active = query.active === undefined ? true : query.active === 'true';
    const where: Prisma.PropertywareBuildingWhereInput = {
      organizationId: user.organizationId,
      isActive: active,
      ...PORTFOLIO_VISIBLE,
      ...(query.portfolioId ? { portfolioId: query.portfolioId } : {}),
      ...(query.city ? { city: { equals: query.city, mode: 'insensitive' } } : {}),
      ...(query.state ? { state: { equals: query.state, mode: 'insensitive' } } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { addressLine1: { contains: query.search, mode: 'insensitive' } },
              { addressLine2: { contains: query.search, mode: 'insensitive' } },
              { city: { contains: query.search, mode: 'insensitive' } },
              { state: { contains: query.search, mode: 'insensitive' } },
              { postalCode: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.hasUpcomingMoveOut === 'true'
        ? { leases: { some: { isActive: true, scheduledMoveOutDate: { gte: new Date() } } } }
        : {}),
      ...(query.hasUnassignedInspection === 'true'
        ? { inspections: { some: { assignments: { none: { isCurrent: true } } } } }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.propertywareBuilding.findMany({
        relationLoadStrategy: 'join',
        where,
        orderBy: { name: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          externalId: true,
          name: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          state: true,
          postalCode: true,
          sourceStatus: true,
          isActive: true,
          lastSyncedAt: true,
          updatedAt: true,
          totalArea: true,
          areaUnits: true,
          category: true,
          manualTotalArea: true,
          manualAreaUnit: true,
          portfolio: { select: { id: true, name: true, externalId: true } },
          units: { where: { isActive: true }, select: { id: true } },
          leases: {
            where: { isActive: true },
            select: {
              unitId: true,
              sourceStatus: true,
              scheduledMoveOutDate: true,
              endDate: true,
            },
          },
          _count: { select: { units: true, inspections: true } },
        },
      }),
      this.prisma.propertywareBuilding.count({ where }),
    ]);
    const shaped = items.map(({ units, leases, ...building }) => ({
      ...building,
      totalArea: this.buildingTotalArea(building),
      leaseSummary: this.leaseSummary(units, leases),
    }));
    return this.page(shaped, total, query);
  }

  // Normalizes a Propertyware area unit label to a compact display form.
  private normalizeAreaUnit(unit: string | null): string | null {
    if (!unit) return null;
    return /sq\s*\.?\s*ft|square\s*feet/i.test(unit) ? 'sq ft' : unit.trim();
  }

  private formatArea(value: number, unit: string | null): string {
    return `${value.toLocaleString('en-US')} ${this.normalizeAreaUnit(unit) ?? 'sq ft'}`;
  }

  /**
   * Resolves a building's total area with an explicit source. A verified
   * Propertyware total takes precedence; an administrator manual value is the
   * fallback; otherwise the area is "Not provided" (never a guessed value).
   */
  private buildingTotalArea(building: {
    totalArea: number | null;
    areaUnits: string | null;
    manualTotalArea: number | null;
    manualAreaUnit: string | null;
    lastSyncedAt: Date;
    updatedAt: Date;
  }) {
    if (building.totalArea && building.totalArea > 0)
      return {
        value: building.totalArea,
        unit: this.normalizeAreaUnit(building.areaUnits) ?? 'sq ft',
        source: 'PROPERTYWARE_BUILDING' as const,
        derived: false,
        updatedAt: building.lastSyncedAt.toISOString(),
        label: this.formatArea(building.totalArea, building.areaUnits),
      };
    if (building.manualTotalArea && building.manualTotalArea > 0)
      return {
        value: building.manualTotalArea,
        unit: this.normalizeAreaUnit(building.manualAreaUnit) ?? 'sq ft',
        source: 'MANUAL' as const,
        derived: false,
        updatedAt: building.updatedAt.toISOString(),
        label: this.formatArea(building.manualTotalArea, building.manualAreaUnit),
      };
    return {
      value: null,
      unit: null,
      source: 'UNKNOWN' as const,
      derived: false,
      updatedAt: null,
      label: 'Not provided',
    };
  }

  /**
   * Summarizes lease posture across a building's active units. Vacancy is
   * derived (an active unit with no active lease); statuses are passed through
   * from Propertyware and never invented.
   *
   * Term end (`endDate`) and scheduled move-out are counted separately and
   * never substituted for one another — see the shared lease-expiry module.
   */
  private leaseSummary(
    units: Array<{ id: string }>,
    leases: Array<{
      unitId: string | null;
      sourceStatus: string | null;
      scheduledMoveOutDate: Date | null;
      endDate?: Date | null;
    }>,
  ) {
    const now = new Date();
    const activeLeaseCount = leases.length;
    const scheduledMoveOutCount = leases.filter((lease) => lease.scheduledMoveOutDate).length;
    // Report-sourced leases have no unit, so they cannot mark one occupied.
    const leasedUnitIds = new Set(
      leases.map((lease) => lease.unitId).filter((id): id is string => Boolean(id)),
    );
    const vacantUnitCount = units.filter((unit) => !leasedUnitIds.has(unit.id)).length;
    const expiringSoonCount = leases.filter(
      (lease) => leaseExpiryStatus(lease.endDate ?? null, now) === 'EXPIRING_SOON',
    ).length;
    // Earliest end still ahead of us; a lease already past its term is not an
    // upcoming date and would be misleading here.
    const upcomingEnds = leases
      .map((lease) => lease.endDate ?? null)
      .filter((end): end is Date => Boolean(end) && (daysUntilLeaseEnd(end, now) ?? -1) >= 0)
      .sort((left, right) => left.getTime() - right.getTime());

    // Vacancy — and therefore "no relevant lease" — is only meaningful once
    // units exist to compare against. With neither units nor leases synced we
    // know nothing about this property and must not imply it has no lease.
    // Report-sourced leases attach at building level with no unit, so their
    // presence alone is enough to have something real to say.
    const leaseDataAvailable = units.length > 0 || leases.length > 0;

    const parts: string[] = [];
    if (activeLeaseCount)
      parts.push(`${activeLeaseCount} active lease${activeLeaseCount === 1 ? '' : 's'}`);
    if (expiringSoonCount)
      parts.push(`${expiringSoonCount} ending within ${LEASE_EXPIRING_SOON_DAYS} days`);
    if (scheduledMoveOutCount)
      parts.push(
        `${scheduledMoveOutCount} scheduled move-out${scheduledMoveOutCount === 1 ? '' : 's'}`,
      );
    if (vacantUnitCount)
      parts.push(`${vacantUnitCount} vacant unit${vacantUnitCount === 1 ? '' : 's'}`);
    return {
      activeLeaseCount,
      scheduledMoveOutCount,
      vacantUnitCount,
      expiringSoonCount,
      leaseDataAvailable,
      nextLeaseEndDate: upcomingEnds[0] ?? null,
      summary: leaseDataAvailable
        ? parts.length
          ? parts.join(' · ')
          : 'No relevant lease'
        : 'Lease data not synchronized',
    };
  }

  async property(user: AuthenticatedUser, id: string) {
    return this.cacheRead({
      resource: 'propertyDetails',
      scope: user.organizationId,
      query: { id },
      loader: () => this.loadProperty(user, id),
    });
  }

  private async loadProperty(user: AuthenticatedUser, id: string) {
    const property = await this.prisma.propertywareBuilding.findFirst({
      relationLoadStrategy: 'join',
      where: { id, organizationId: user.organizationId },
      select: {
        id: true,
        externalId: true,
        name: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        postalCode: true,
        sourceStatus: true,
        isActive: true,
        lastSyncedAt: true,
        updatedAt: true,
        totalArea: true,
        areaUnits: true,
        category: true,
        manualTotalArea: true,
        manualAreaUnit: true,
        portfolio: { select: { id: true, externalId: true, name: true } },
        units: {
          where: { isActive: true },
          orderBy: { name: 'asc' },
          take: 25,
          select: {
            id: true,
            externalId: true,
            name: true,
            bedrooms: true,
            bathrooms: true,
            isActive: true,
            lastSyncedAt: true,
          },
        },
        leases: {
          where: { isActive: true },
          orderBy: { scheduledMoveOutDate: 'asc' },
          take: 25,
          select: {
            id: true,
            externalId: true,
            unitId: true,
            leaseName: true,
            sourceStatus: true,
            startDate: true,
            endDate: true,
            scheduledMoveOutDate: true,
            // Leases are exempt from absence-based deactivation: they come from
            // a published report, which is a view rather than a full inventory,
            // so one dropping out of a run is not evidence the tenancy ended.
            // That makes this the only signal that a lease stopped being
            // confirmed, and it is worth showing rather than leaving buried.
            lastSeenAt: true,
          },
        },
      },
    });
    if (!property) throw new ApplicationError(404, 'PROPERTY_NOT_FOUND', 'Property was not found.');
    const { totalArea, areaUnits, category, manualTotalArea, manualAreaUnit, updatedAt, ...rest } =
      property;
    // The relevant lease for a unit is its active lease; a unit with none reads
    // "No relevant lease" (null) rather than an invented status.
    const relevantLease = new Map(property.leases.map((lease) => [lease.unitId, lease]));
    return {
      ...rest,
      category,
      totalArea: this.buildingTotalArea({
        totalArea,
        areaUnits,
        manualTotalArea,
        manualAreaUnit,
        lastSyncedAt: property.lastSyncedAt,
        updatedAt,
      }),
      leaseSummary: this.leaseSummary(
        property.units,
        property.leases.map((lease) => ({
          unitId: lease.unitId,
          sourceStatus: lease.sourceStatus,
          scheduledMoveOutDate: lease.scheduledMoveOutDate,
          endDate: lease.endDate,
        })),
      ),
      units: property.units.map((unit) => ({
        ...unit,
        leaseStatus: relevantLease.get(unit.id)?.sourceStatus ?? null,
        scheduledMoveOutDate: relevantLease.get(unit.id)?.scheduledMoveOutDate ?? null,
        leaseEndDate: relevantLease.get(unit.id)?.endDate ?? null,
      })),
    };
  }

  async propertyLeaseSummary(user: AuthenticatedUser, id: string) {
    const property = await this.property(user, id);
    return {
      propertyId: id,
      ...property.leaseSummary,
      units: property.units.map((unit) => ({
        id: unit.id,
        name: unit.name,
        leaseStatus: unit.leaseStatus,
        scheduledMoveOutDate: unit.scheduledMoveOutDate,
        leaseEndDate: unit.leaseEndDate,
        daysUntilLeaseEnd: daysUntilLeaseEnd(unit.leaseEndDate),
      })),
    };
  }

  async propertyAreaSummary(user: AuthenticatedUser, id: string) {
    const property = await this.property(user, id);
    return { propertyId: id, totalArea: property.totalArea, category: property.category ?? null };
  }

  async units(user: AuthenticatedUser, propertyId: string, query: UnitListQueryDto) {
    return this.cacheRead({
      resource: 'units',
      scope: user.organizationId,
      query: { propertyId, ...query },
      loader: () => this.loadUnits(user, propertyId, query),
    });
  }

  private async loadUnits(user: AuthenticatedUser, propertyId: string, query: UnitListQueryDto) {
    const where = {
      organizationId: user.organizationId,
      buildingId: propertyId,
      isActive: query.active === undefined ? true : query.active === 'true',
      ...(query.vacant !== undefined ? { vacant: query.vacant === 'true' } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { addressLine1: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    } satisfies Prisma.PropertywareUnitWhereInput;
    const [items, total] = await Promise.all([
      this.prisma.propertywareUnit.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          externalId: true,
          name: true,
          bedrooms: true,
          bathrooms: true,
          isActive: true,
          lastSyncedAt: true,
        },
      }),
      this.prisma.propertywareUnit.count({ where }),
    ]);
    return this.page(items, total, query);
  }

  async unit(user: AuthenticatedUser, id: string) {
    const unit = await this.prisma.propertywareUnit.findFirst({
      where: { id, organizationId: user.organizationId },
      select: {
        id: true,
        externalId: true,
        name: true,
        bedrooms: true,
        bathrooms: true,
        isActive: true,
        lastSyncedAt: true,
        building: { select: { id: true, name: true, addressLine1: true } },
        portfolio: { select: { id: true, name: true } },
      },
    });
    if (!unit) throw new ApplicationError(404, 'UNIT_NOT_FOUND', 'Unit was not found.');
    return unit;
  }

  async leases(user: AuthenticatedUser, unitId: string, query: LeaseListQueryDto) {
    return this.cacheRead({
      resource: 'leases',
      scope: user.organizationId,
      query: { unitId, ...query },
      loader: () => this.loadLeases(user, unitId, query),
    });
  }

  private async loadLeases(user: AuthenticatedUser, unitId: string, query: LeaseListQueryDto) {
    const where = {
      organizationId: user.organizationId,
      unitId,
      isActive: query.active === undefined ? true : query.active === 'true',
      ...(query.status
        ? { sourceStatus: { equals: query.status, mode: 'insensitive' as const } }
        : {}),
      ...(query.scheduledMoveOutFrom || query.scheduledMoveOutTo
        ? {
            scheduledMoveOutDate: {
              gte: query.scheduledMoveOutFrom ? new Date(query.scheduledMoveOutFrom) : undefined,
              lte: query.scheduledMoveOutTo ? new Date(query.scheduledMoveOutTo) : undefined,
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { leaseName: { contains: query.search, mode: 'insensitive' as const } },
              { externalId: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    } satisfies Prisma.PropertywareLeaseWhereInput;
    const [items, total] = await Promise.all([
      this.prisma.propertywareLease.findMany({
        where,
        orderBy: { scheduledMoveOutDate: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          externalId: true,
          leaseName: true,
          sourceStatus: true,
          startDate: true,
          endDate: true,
          scheduledMoveOutDate: true,
        },
      }),
      this.prisma.propertywareLease.count({ where }),
    ]);
    return this.page(items, total, query);
  }

  async inspections(user: AuthenticatedUser, query: InspectionListQueryDto) {
    const assignmentFilters: Prisma.InspectionWhereInput[] = [
      ...(query.technicianId
        ? [{ assignments: { some: { technicianId: query.technicianId, isCurrent: true } } }]
        : []),
      ...(query.assignmentStatus === 'ASSIGNED'
        ? [{ assignments: { some: { isCurrent: true } } }]
        : []),
      ...(query.assignmentStatus === 'UNASSIGNED' || query.unassignedOnly === 'true'
        ? [{ assignments: { none: { isCurrent: true } } }]
        : []),
    ];
    const where: Prisma.InspectionWhereInput = {
      organizationId: user.organizationId,
      ...(query.propertyId ? { propertywareBuildingId: query.propertyId } : {}),
      ...(query.portfolioId ? { propertywareBuilding: { portfolioId: query.portfolioId } } : {}),
      ...(query.status ? { status: query.status as InspectionStatus } : {}),
      ...(query.inspectionType ? { inspectionType: query.inspectionType } : {}),
      ...(assignmentFilters.length ? { AND: assignmentFilters } : {}),
      ...(query.scheduledFrom || query.scheduledTo
        ? {
            scheduledAt: {
              gte: query.scheduledFrom ? new Date(query.scheduledFrom) : undefined,
              lte: query.scheduledTo ? new Date(query.scheduledTo) : undefined,
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { propertywareBuilding: { name: { contains: query.search, mode: 'insensitive' } } },
              {
                propertywareBuilding: {
                  addressLine1: { contains: query.search, mode: 'insensitive' },
                },
              },
              { propertywareUnit: { name: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const select = {
      id: true,
      status: true,
      inspectionType: true,
      baselineInspectionId: true,
      baselineInspection: {
        select: { id: true, inspectionType: true, scheduledAt: true, completedAt: true },
      },
      priority: true,
      scheduledAt: true,
      createdAt: true,
      updatedAt: true,
      internalNotes: true,
      propertywareBuilding: {
        select: { id: true, name: true, addressLine1: true, city: true, state: true },
      },
      propertywareUnit: { select: { id: true, name: true } },
      propertywareLease: { select: { id: true, leaseName: true, scheduledMoveOutDate: true } },
      assignments: {
        where: { isCurrent: true },
        select: {
          id: true,
          inspectionId: true,
          technicianId: true,
          assignedById: true,
          status: true,
          isCurrent: true,
          assignedAt: true,
          endedAt: true,
          reason: true,
          technician: {
            select: { id: true, displayName: true, email: true, isActive: true },
          },
        },
      },
    } satisfies Prisma.InspectionSelect;
    const [items, total] = await Promise.all([
      this.prisma.inspection.findMany({
        relationLoadStrategy: 'join',
        where,
        select,
        orderBy: { scheduledAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.inspection.count({ where }),
    ]);
    return this.page(items, total, query);
  }

  async inspection(user: AuthenticatedUser, id: string) {
    const inspection = await this.prisma.inspection.findFirst({
      relationLoadStrategy: 'join',
      where: { id, organizationId: user.organizationId },
      select: {
        id: true,
        status: true,
        inspectionType: true,
        baselineInspectionId: true,
        baselineInspection: {
          select: { id: true, inspectionType: true, scheduledAt: true, completedAt: true },
        },
        priority: true,
        scheduledAt: true,
        startedAt: true,
        submittedAt: true,
        completedAt: true,
        finalizedAt: true,
        finalizedBy: { select: { id: true, displayName: true } },
        completionBlockedReason: true,
        tbdReason: true,
        followUpRequired: true,
        followUpDueAt: true,
        followUpTasks: true,
        parentInspectionId: true,
        inspectionRound: true,
        createdAt: true,
        updatedAt: true,
        internalNotes: true,
        propertywareBuilding: {
          select: { id: true, name: true, addressLine1: true, city: true, state: true },
        },
        propertywareUnit: { select: { id: true, name: true } },
        propertywareLease: {
          select: { id: true, leaseName: true, scheduledMoveOutDate: true },
        },
        assignments: {
          where: { isCurrent: true },
          take: 1,
          select: {
            id: true,
            inspectionId: true,
            technicianId: true,
            assignedById: true,
            status: true,
            isCurrent: true,
            assignedAt: true,
            endedAt: true,
            reason: true,
            technician: { select: { id: true, displayName: true, email: true, isActive: true } },
            assignedBy: { select: { id: true, displayName: true } },
            endedBy: { select: { id: true, displayName: true } },
          },
        },
        _count: { select: { areas: true, findings: true } },
      },
    });
    if (!inspection)
      throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
    return inspection;
  }

  async inspectionAudit(user: AuthenticatedUser, id: string, query: AuditListQueryDto) {
    const where = {
      organizationId: user.organizationId,
      entityType: 'Inspection',
      entityId: id,
    } satisfies Prisma.AuditLogWhereInput;
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        // Metadata may contain sensitive reasons; the audit list exposes only the
        // action and timestamp. Human-readable reasons live on the inspection
        // detail (tbdReason / completionBlockedReason / follow-up tasks).
        select: { id: true, action: true, createdAt: true },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return this.page(items, total, query);
  }

  async createInspection(user: AuthenticatedUser, input: CreateAdminInspectionDto) {
    const inspection = await this.prisma.$transaction(async (tx) => {
      const property = await this.requireBuilding(user.organizationId, input.propertyId, true, tx);
      const unit = input.unitId
        ? await tx.propertywareUnit.findFirst({
            where: {
              id: input.unitId,
              organizationId: user.organizationId,
              buildingId: property.id,
              isActive: true,
            },
            select: {
              id: true,
              externalId: true,
              name: true,
              addressLine1: true,
              addressLine2: true,
              city: true,
              state: true,
              postalCode: true,
            },
          })
        : null;
      if (input.unitId && !unit)
        throw new ApplicationError(
          422,
          'INVALID_ACTIVE_UNIT',
          'Select an active unit belonging to this property.',
        );
      if (!unit) {
        // Multi-unit buildings must inspect a specific unit; "entire property"
        // is only valid for buildings without active units.
        const activeUnits = await tx.propertywareUnit.count({
          where: { buildingId: property.id, organizationId: user.organizationId, isActive: true },
        });
        if (activeUnits > 0)
          throw new ApplicationError(
            422,
            'UNIT_REQUIRED',
            'This property has units. Select which unit this inspection covers.',
          );
      }
      if (input.leaseId && !unit)
        throw new ApplicationError(
          422,
          'LEASE_REQUIRES_UNIT',
          'Select the lease unit before selecting a lease.',
        );
      const lease = input.leaseId
        ? await tx.propertywareLease.findFirst({
            where: {
              id: input.leaseId,
              organizationId: user.organizationId,
              unitId: unit!.id,
              isActive: true,
            },
            select: {
              id: true,
              externalId: true,
              leaseName: true,
              sourceStatus: true,
              startDate: true,
              endDate: true,
              scheduledMoveOutDate: true,
            },
          })
        : null;
      if (input.leaseId && !lease)
        throw new ApplicationError(
          422,
          'INVALID_LEASE_RELATIONSHIP',
          'The selected lease is not valid for this unit.',
        );
      const scheduledAt = new Date(input.scheduledAt);
      const baselineInspectionId = await this.resolveLifecycleBaseline(tx, {
        organizationId: user.organizationId,
        propertyId: property.id,
        unitId: unit?.id ?? null,
        leaseId: lease?.id ?? null,
        inspectionType: input.inspectionType,
        scheduledAt,
      });
      // Prefer the unit's own approved layout; fall back to the building-level
      // layout when the unit has none (identical-layout buildings share one
      // building-level plan instead of duplicating it per unit).
      const unitAreas = unit
        ? await tx.propertyArea.findMany({
            where: {
              propertyId: property.id,
              unitId: unit.id,
              status: PropertyAreaStatus.APPROVED,
            },
            orderBy: { inspectionOrder: 'asc' },
            select: { id: true },
          })
        : [];
      const approvedAreas = unitAreas.length
        ? unitAreas
        : await tx.propertyArea.findMany({
            where: {
              propertyId: property.id,
              unitId: null,
              status: PropertyAreaStatus.APPROVED,
            },
            orderBy: { inspectionOrder: 'asc' },
            select: { id: true },
          });
      // An inspection normally starts from an approved layout. The exception is
      // a property nobody has surveyed yet: rather than block it, or flatten it
      // to a single "Entire property" area and lose the per-area structure the
      // whole review is organised around, the technician builds the list on
      // site. What they add is still DRAFT on the property, so an administrator
      // approves the permanent layout — this delegates the survey, not the
      // approval.
      const technicianWillCapture = input.allowTechnicianAreaCapture === true;
      if (!approvedAreas.length && !technicianWillCapture)
        throw new ApplicationError(
          409,
          'NO_APPROVED_AREAS',
          unit
            ? 'Approve a floor plan for this unit (or a building-level plan) before creating an inspection.'
            : 'Upload or define the property floor plan and approve its areas before creating an inspection.',
        );
      const duplicate = await tx.inspection.findFirst({
        where: {
          organizationId: user.organizationId,
          propertywareBuildingId: property.id,
          propertywareUnitId: unit?.id ?? null,
          scheduledAt,
          status: { not: InspectionStatus.CANCELLED },
        },
        select: { id: true },
      });
      if (duplicate)
        throw new ApplicationError(
          409,
          'DUPLICATE_INSPECTION',
          'An inspection already exists for this unit and schedule.',
        );
      let inspection;
      try {
        inspection = await tx.inspection.create({
          data: {
            organizationId: user.organizationId,
            propertywareBuildingId: property.id,
            propertywareUnitId: unit?.id,
            propertywareLeaseId: lease?.id,
            inspectionType: input.inspectionType,
            baselineInspectionId,
            priority: input.priority,
            internalNotes: input.internalNotes,
            createdById: user.id,
            scheduledAt,
            // Recorded even when the property turned out to have areas after
            // all: it is the administrator's instruction to the technician, not
            // a description of what the property had at the time.
            allowTechnicianAreaCapture: technicianWillCapture,
            propertySnapshot: this.propertySnapshot(property, unit),
            leaseSnapshot: lease ? this.leaseSnapshot(lease) : Prisma.JsonNull,
            areas: {
              create: approvedAreas.map((area) => ({ propertyAreaId: area.id })),
            },
          },
        });
      } catch (error) {
        // The partial unique index on (org, building, unit, scheduledAt) is the
        // race-proof backstop behind the friendly findFirst check above.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
          throw new ApplicationError(
            409,
            'DUPLICATE_INSPECTION',
            'An inspection already exists for this unit and schedule.',
          );
        throw error;
      }
      await this.audit(tx, user, 'INSPECTION_CREATED', inspection.id, {
        priority: input.priority,
        inspectionType: input.inspectionType,
        baselineInspectionId,
        // Worth an audit entry: it is the decision to inspect a property whose
        // layout nobody has approved, and it explains an inspection that begins
        // with no areas at all.
        allowTechnicianAreaCapture: technicianWillCapture,
        areasFromApprovedPlan: approvedAreas.length,
      });
      if (input.technicianId)
        await this.createAssignment(
          tx,
          user,
          inspection.id,
          input.technicianId,
          input.idempotencyKey,
        );
      if (input.technicianId)
        await this.audit(tx, user, 'INSPECTION_ASSIGNED', inspection.id, {
          technicianId: input.technicianId,
          source: 'INSPECTION_CREATION',
        });
      return { id: inspection.id };
    }, ADMIN_TRANSACTION_OPTIONS);
    if (inspection && input.technicianId) {
      this.technicianEvents?.publish(input.technicianId, inspection.id, 'ASSIGNED');
      this.notifyAssignmentByEmail(user.organizationId, inspection.id, input.technicianId);
    }
    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    // The committed primary read is the mutation's authoritative response.
    // Clients must not have to invalidate and race a potentially older list
    // response just to learn the entity they created.
    return this.inspection(user, inspection.id);
  }

  async updateInspection(user: AuthenticatedUser, id: string, input: UpdateAdminInspectionDto) {
    const existing = await this.requireInspection(user.organizationId, id);
    if (
      existing.status === InspectionStatus.COMPLETED ||
      existing.status === InspectionStatus.CANCELLED
    )
      throw new ApplicationError(
        409,
        'INSPECTION_FINALIZED',
        'A completed or cancelled inspection cannot be changed.',
      );
    if (input.status === 'CANCELLED' && !input.cancellationReason)
      throw new ApplicationError(
        422,
        'CANCELLATION_REASON_REQUIRED',
        'Provide a cancellation reason.',
      );
    const updated = await this.prisma.$transaction(async (tx) => {
      if (input.scheduledAt) {
        const duplicate = await tx.inspection.findFirst({
          where: {
            id: { not: id },
            organizationId: user.organizationId,
            propertywareBuildingId: existing.propertywareBuildingId,
            propertywareUnitId: existing.propertywareUnitId,
            scheduledAt: new Date(input.scheduledAt),
            status: { not: InspectionStatus.CANCELLED },
          },
        });
        if (duplicate)
          throw new ApplicationError(
            409,
            'DUPLICATE_INSPECTION',
            'An inspection already exists for this property, unit, and schedule.',
          );
      }
      const updated = await tx.inspection.update({
        where: { id },
        data: {
          scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
          priority: input.priority,
          internalNotes: input.internalNotes,
          status: input.status as InspectionStatus | undefined,
          cancelledAt: input.status === 'CANCELLED' ? new Date() : undefined,
          cancellationReason: input.cancellationReason,
        },
      });
      const current =
        input.status === 'CANCELLED'
          ? await tx.inspectionAssignment.findFirst({
              where: { inspectionId: id, isCurrent: true },
            })
          : null;
      if (current)
        await tx.inspectionAssignment.update({
          where: { id: current.id },
          data: {
            isCurrent: false,
            status: 'UNASSIGNED',
            endedAt: new Date(),
            endedById: user.id,
            reason: `Inspection cancelled: ${input.cancellationReason}`,
          },
        });
      await this.audit(
        tx,
        user,
        input.status === 'CANCELLED' ? 'INSPECTION_CANCELLED' : 'INSPECTION_UPDATED',
        id,
        { ...input, closedAssignmentId: current?.id },
      );
      return updated;
    }, ADMIN_TRANSACTION_OPTIONS);
    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    return updated;
  }

  /**
   * Finalize (complete) an inspection — a human-only decision (spec §11).
   * Blocked while required review items remain (findings pending review or media
   * still processing) unless a documented override reason is supplied, which is
   * recorded in the audit trail. Only a principal with `inspections:finalize`
   * reaches this method (enforced by the controller guard).
   */
  async finalizeInspection(user: AuthenticatedUser, id: string, input: FinalizeInspectionDto) {
    const existing = await this.requireInspection(user.organizationId, id);
    this.assertReviewable(existing.status);
    const [pendingFindings, unfinishedMedia] = await Promise.all([
      this.prisma.inspectionFinding.count({
        where: { inspectionId: id, reviewStatus: FindingReviewStatus.PENDING_REVIEW },
      }),
      this.prisma.inspectionMedia.count({
        where: {
          inspectionId: id,
          processingStatus: {
            in: [MediaProcessingStatus.PENDING, MediaProcessingStatus.PROCESSING],
          },
        },
      }),
    ]);
    const blockers = pendingFindings + unfinishedMedia;
    if (blockers > 0 && !input.overrideReason)
      throw new ApplicationError(
        409,
        'INSPECTION_HAS_UNRESOLVED_ITEMS',
        `${pendingFindings} finding(s) awaiting review and ${unfinishedMedia} recording(s) still processing. Resolve them or document an override to finalize.`,
      );
    await this.prisma.$transaction(async (tx) => {
      await tx.inspection.update({
        where: { id },
        data: {
          status: InspectionStatus.COMPLETED,
          completedAt: new Date(),
          finalizedAt: new Date(),
          finalizedById: user.id,
          // Finalization clears any pending-finalization hold.
          completionBlockedReason: null,
          tbdReason: null,
          followUpRequired: false,
        },
      });
      await this.audit(tx, user, 'INSPECTION_FINALIZED', id, {
        pendingFindings,
        unfinishedMedia,
        override: blockers > 0,
        overrideReason: input.overrideReason ?? null,
      });
    }, ADMIN_TRANSACTION_OPTIONS);
    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    return this.inspection(user, id);
  }

  /** Mark an inspection TBD / pending-finalization with an optional reason. */
  async markInspectionTbd(user: AuthenticatedUser, id: string, input: InspectionTbdDto) {
    await this.transitionReview(user, id, {
      status: InspectionStatus.TBD,
      action: 'INSPECTION_MARKED_TBD',
      data: {
        tbdReason: input.reason ?? null,
        completionBlockedReason: input.reason ?? 'Pending administrator determination.',
      },
      metadata: { reason: input.reason ?? null },
    });
    return this.inspection(user, id);
  }

  /** Require a follow-up inspection with an optional planned date and tasks. */
  async requireInspectionFollowUp(
    user: AuthenticatedUser,
    id: string,
    input: InspectionFollowUpDto,
  ) {
    await this.transitionReview(user, id, {
      status: InspectionStatus.FOLLOW_UP_REQUIRED,
      action: 'INSPECTION_FOLLOW_UP_REQUIRED',
      data: {
        followUpRequired: true,
        followUpDueAt: input.dueAt ? new Date(input.dueAt) : null,
        followUpTasks: input.tasks ?? null,
        completionBlockedReason: input.reason ?? 'Follow-up inspection required.',
      },
      metadata: { dueAt: input.dueAt ?? null, tasks: input.tasks ?? null, reason: input.reason ?? null },
    });
    return this.inspection(user, id);
  }

  /** Move an inspection into administrator review / request more evidence. */
  async markInspectionUnderReview(
    user: AuthenticatedUser,
    id: string,
    input: InspectionUnderReviewDto,
  ) {
    await this.transitionReview(user, id, {
      status: InspectionStatus.UNDER_REVIEW,
      action: 'INSPECTION_UNDER_REVIEW',
      data: { completionBlockedReason: input.reason ?? null },
      metadata: { reason: input.reason ?? null },
    });
    return this.inspection(user, id);
  }

  /**
   * Send an inspection back to the technician for more capture.
   *
   * Returns it to IN_PROGRESS, which is what puts it back in the assigned
   * technician's queue — that queue is SCHEDULED + IN_PROGRESS only, so nothing
   * short of this makes the inspection actionable on the handset again.
   *
   * Evidence is never touched. Existing recordings, photos and findings survive
   * a reopen; the technician adds to them rather than starting over.
   *
   * `finalizedAt` / `finalizedById` / `completedAt` are deliberately KEPT, and
   * read as "last finalized" rather than "is finalized" — `status` is the only
   * authority on the current state. Nothing in the backend branches on them;
   * they are selected for display alone.
   *
   * They are load-bearing as history. Two guards protect the evidence behind a
   * closed inspection — technician photo deletion and renaming a
   * technician-created area — and both used to key on status === COMPLETED,
   * which was safe only while COMPLETED was terminal. Reopening would have
   * re-armed them, letting a technician hard-delete a photo (and its object in
   * storage) out of an inspection that had already been finalized and possibly
   * shared with an owner. `finalizedAt` outliving the reopen is what keeps them
   * shut; an earlier revision of this method nulled it and opened both.
   *
   * Review determinations (`tbdReason`, `followUpRequired`, `followUpTasks`) are
   * deliberately left alone. Reopening is how a follow-up gets actioned, not
   * evidence that it is resolved, and silently clearing an administrator's
   * determination would destroy the reason the inspection was held.
   */
  async reopenInspection(user: AuthenticatedUser, id: string, input: ReopenInspectionDto) {
    const existing = await this.requireInspection(user.organizationId, id);
    if (existing.status === InspectionStatus.CANCELLED)
      throw new ApplicationError(
        409,
        'INSPECTION_CANCELLED',
        'A cancelled inspection cannot be reopened. Create a new inspection instead.',
      );
    if (!REOPENABLE_INSPECTION_STATUSES.includes(existing.status))
      throw new ApplicationError(
        409,
        'INSPECTION_NOT_REOPENABLE',
        'Only an inspection the technician has already submitted can be reopened.',
      );
    // An inspection nobody is assigned to reaches no one once reopened. It is
    // not an error — the admin may be about to assign it — so this is recorded
    // rather than refused, and the inspections list already flags unassigned
    // work on its own.
    const currentAssignments = await this.prisma.inspectionAssignment.count({
      where: { inspectionId: id, isCurrent: true },
    });
    await this.prisma.$transaction(async (tx) => {
      // The status is re-asserted in the WHERE clause. The check above ran on
      // `this.prisma`, outside this transaction, so Serializable cannot detect
      // a conflict on a row it never read here — a concurrent finalize could
      // land in between and this would silently write an audit row claiming
      // `wasFinalized: false` about a finalization it had just reversed.
      const { count } = await tx.inspection.updateMany({
        where: { id, status: { in: REOPENABLE_INSPECTION_STATUSES } },
        data: {
          status: InspectionStatus.IN_PROGRESS,
          // submittedAt is left too: the technician's next submission
          // overwrites it, and until then it records when the work last left
          // the field.
          completionBlockedReason: null,
        },
      });
      if (count === 0)
        throw new ApplicationError(
          409,
          'INSPECTION_NOT_REOPENABLE',
          'The inspection changed while it was being reopened. Reload and try again.',
        );
      await this.audit(tx, user, 'INSPECTION_REOPENED', id, {
        fromStatus: existing.status,
        reason: input.reason,
        wasFinalized: existing.status === InspectionStatus.COMPLETED,
        hadCurrentAssignment: currentAssignments > 0,
      });
    }, ADMIN_TRANSACTION_OPTIONS);
    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    return this.inspection(user, id);
  }

  /**
   * Asks the technician for more evidence in one specific area.
   *
   * This is the piece the workflow was missing. The office could already send
   * an inspection back — `reopenInspection` returns it to IN_PROGRESS, which is
   * what puts it in the technician's queue — but only as a whole, with no
   * statement of what was wrong. The technician saw a finished job reappear and
   * had to phone someone to find out why. A request names the area, optionally
   * the exact checklist items, and what is needed.
   *
   * Reopening is *part of* creating the request, in the same transaction: a
   * request the technician cannot reach is not a request, and the two must not
   * be able to drift apart. When the inspection is already IN_PROGRESS there is
   * nothing to reopen and the status is left alone.
   */
  async createEvidenceRequest(
    user: AuthenticatedUser,
    inspectionId: string,
    input: CreateEvidenceRequestDto,
  ) {
    const existing = await this.requireInspection(user.organizationId, inspectionId);
    if (existing.status === InspectionStatus.CANCELLED)
      throw new ApplicationError(
        409,
        'INSPECTION_CANCELLED',
        'A cancelled inspection cannot be sent back for more evidence.',
      );

    const area = await this.prisma.inspectionArea.findFirst({
      where: { id: input.inspectionAreaId, inspectionId },
      select: { id: true, propertyAreaId: true },
    });
    if (!area)
      throw new ApplicationError(
        404,
        'INSPECTION_AREA_NOT_FOUND',
        'That area does not belong to this inspection.',
      );

    // Validated against the area's own checklist, so a request can never point
    // at an item the technician's app will not show them.
    const itemIds: string[] = [...new Set(input.checklistItemIds ?? [])];
    if (itemIds.length) {
      const found = await this.prisma.areaChecklistItem.count({
        where: { id: { in: itemIds }, propertyAreaId: area.propertyAreaId, archivedAt: null },
      });
      if (found !== itemIds.length)
        throw new ApplicationError(
          400,
          'CHECKLIST_ITEM_NOT_IN_AREA',
          'One or more checklist items do not belong to that area.',
        );
    }

    const reopenable = REOPENABLE_INSPECTION_STATUSES.includes(existing.status);
    const request = await this.prisma.$transaction(async (tx) => {
      const created = await tx.areaEvidenceRequest.create({
        data: {
          organizationId: user.organizationId,
          inspectionId,
          inspectionAreaId: area.id,
          checklistItemIds: itemIds,
          note: input.note.trim(),
          requestedById: user.id,
        },
        select: EVIDENCE_REQUEST_SELECT,
      });
      if (reopenable) {
        // Same re-assertion as reopenInspection: the status was read outside
        // this transaction, so a concurrent finalize could otherwise be
        // silently reversed here.
        const { count } = await tx.inspection.updateMany({
          where: { id: inspectionId, status: { in: REOPENABLE_INSPECTION_STATUSES } },
          data: { status: InspectionStatus.IN_PROGRESS, completionBlockedReason: null },
        });
        if (count === 0)
          throw new ApplicationError(
            409,
            'INSPECTION_NOT_REOPENABLE',
            'The inspection changed while evidence was being requested. Reload and try again.',
          );
      }
      await this.audit(tx, user, 'INSPECTION_EVIDENCE_REQUESTED', inspectionId, {
        inspectionAreaId: area.id,
        checklistItemIds: itemIds,
        reopenedFrom: reopenable ? existing.status : null,
      });
      return created;
    }, ADMIN_TRANSACTION_OPTIONS);

    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    return request;
  }

  async evidenceRequests(user: AuthenticatedUser, inspectionId: string) {
    await this.requireInspection(user.organizationId, inspectionId);
    return this.prisma.areaEvidenceRequest.findMany({
      where: { inspectionId },
      orderBy: [{ status: 'asc' }, { requestedAt: 'desc' }],
      select: EVIDENCE_REQUEST_SELECT,
    });
  }

  /**
   * Withdraws a request the office no longer needs.
   *
   * Cancelled rather than deleted: the technician may already have seen it and
   * started work, and a request that silently disappears leaves them unable to
   * find out what happened to it.
   */
  async cancelEvidenceRequest(user: AuthenticatedUser, requestId: string) {
    const { count } = await this.prisma.areaEvidenceRequest.updateMany({
      where: {
        id: requestId,
        organizationId: user.organizationId,
        status: EvidenceRequestStatus.OPEN,
      },
      data: {
        status: EvidenceRequestStatus.CANCELLED,
        resolvedById: user.id,
        resolvedAt: new Date(),
      },
    });
    if (count === 0)
      throw new ApplicationError(
        404,
        'EVIDENCE_REQUEST_NOT_FOUND',
        'That request was not found, or is no longer open.',
      );
    return this.prisma.areaEvidenceRequest.findFirstOrThrow({
      where: { id: requestId },
      select: EVIDENCE_REQUEST_SELECT,
    });
  }

  /** Inspection areas for the workflow merge UI. */
  async inspectionAreas(user: AuthenticatedUser, id: string) {
    await this.requireInspection(user.organizationId, id);
    const areas = await this.prisma.inspectionArea.findMany({
      where: { inspectionId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        completionStatus: true,
        propertyArea: {
          select: {
            id: true,
            name: true,
            environment: true,
            floor: { select: { name: true } },
          },
        },
        _count: { select: { media: true, photos: true } },
      },
    });
    return areas.map((area) => ({
      id: area.id,
      propertyAreaId: area.propertyArea.id,
      name: area.propertyArea.name,
      floorName: area.propertyArea.floor?.name ?? null,
      environment: area.propertyArea.environment,
      completionStatus: area.completionStatus,
      mediaCount: area._count.media,
      photoCount: area._count.photos,
    }));
  }

  /**
   * Merge a duplicate inspection area into another within the SAME inspection
   * (spec §16). All evidence is preserved: media, photos, upload sessions, and
   * status history are reassigned to the target area, and the source area's
   * findings (keyed by property area) are repointed to the target's property
   * area. To honour the one-primary-video-per-area invariant, a source primary
   * walkthrough is demoted to an additional labeled clip when the target already
   * has a primary. The source room name is preserved as an alias so future
   * comparisons can still match it. Never merges across inspections.
   */
  async mergeInspectionAreas(
    user: AuthenticatedUser,
    inspectionId: string,
    input: MergeInspectionAreasDto,
  ) {
    if (input.sourceAreaId === input.targetAreaId)
      throw new ApplicationError(
        422,
        'INVALID_MERGE',
        'Choose two different areas to merge.',
      );
    const inspection = await this.requireInspection(user.organizationId, inspectionId);
    if (FROZEN_INSPECTION_STATUSES.includes(inspection.status))
      throw new ApplicationError(
        409,
        'INSPECTION_FINALIZED',
        'A completed or cancelled inspection cannot be changed.',
      );
    const summary = await this.prisma.$transaction(async (tx) => {
      const areaSelect = {
        id: true,
        propertyAreaId: true,
        propertyArea: { select: { name: true } },
      } satisfies Prisma.InspectionAreaSelect;
      const [source, target] = await Promise.all([
        tx.inspectionArea.findFirst({
          where: { id: input.sourceAreaId, inspectionId },
          select: areaSelect,
        }),
        tx.inspectionArea.findFirst({
          where: { id: input.targetAreaId, inspectionId },
          select: areaSelect,
        }),
      ]);
      if (!source || !target)
        throw new ApplicationError(
          404,
          'AREA_NOT_FOUND',
          'Both areas must belong to this inspection.',
        );

      // Preserve the one-PRIMARY_AREA-video-per-area invariant. A source area has
      // at most one primary (partial unique index); keep it as the target's
      // primary only if the target has none, otherwise demote it to an extra.
      const targetPrimaries = await tx.inspectionMedia.count({
        where: { inspectionAreaId: target.id, recordingType: VideoRecordingType.PRIMARY_AREA },
      });
      const sourcePrimaries = await tx.inspectionMedia.findMany({
        where: { inspectionAreaId: source.id, recordingType: VideoRecordingType.PRIMARY_AREA },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      const keepPrimaryIds =
        targetPrimaries === 0 ? sourcePrimaries.slice(0, 1).map((m) => m.id) : [];
      const demoteIds = sourcePrimaries
        .filter((m) => !keepPrimaryIds.includes(m.id))
        .map((m) => m.id);
      if (demoteIds.length)
        await tx.inspectionMedia.updateMany({
          where: { id: { in: demoteIds } },
          data: {
            recordingType: VideoRecordingType.ADDITIONAL_ISSUE,
            label: `Merged from ${source.propertyArea.name}`,
          },
        });

      const [movedMedia, movedPhotos] = await Promise.all([
        tx.inspectionMedia.updateMany({
          where: { inspectionAreaId: source.id },
          data: { inspectionAreaId: target.id },
        }),
        tx.inspectionPhoto.updateMany({
          where: { inspectionAreaId: source.id },
          data: { inspectionAreaId: target.id },
        }),
      ]);
      await tx.mediaUploadSession.updateMany({
        where: { inspectionAreaId: source.id },
        data: { inspectionAreaId: target.id },
      });
      await tx.inspectionAreaStatusHistory.updateMany({
        where: { inspectionAreaId: source.id },
        data: { inspectionAreaId: target.id },
      });
      // Findings link to the catalog area by propertyAreaId; repoint only this
      // inspection's findings for the merged source area.
      const movedFindings = await tx.inspectionFinding.updateMany({
        where: { inspectionId, propertyAreaId: source.propertyAreaId },
        data: { propertyAreaId: target.propertyAreaId },
      });

      // Preserve the source room name as an alias of the target catalog area so
      // renamed/duplicate rooms match in future comparisons. Check first — a
      // duplicate insert would abort the whole transaction.
      if (source.propertyArea.name && source.propertyArea.name !== target.propertyArea.name) {
        const existingAlias = await tx.propertyAreaAlias.findFirst({
          where: { propertyAreaId: target.propertyAreaId, alias: source.propertyArea.name },
          select: { id: true },
        });
        if (!existingAlias)
          await tx.propertyAreaAlias.create({
            data: {
              propertyAreaId: target.propertyAreaId,
              alias: source.propertyArea.name,
              createdById: user.id,
            },
          });
      }

      await tx.inspectionArea.delete({ where: { id: source.id } });
      const result = {
        movedMedia: movedMedia.count,
        movedPhotos: movedPhotos.count,
        movedFindings: movedFindings.count,
        demotedPrimaries: demoteIds.length,
      };
      await this.audit(tx, user, 'INSPECTION_AREAS_MERGED', inspectionId, {
        sourceAreaId: source.id,
        targetAreaId: target.id,
        sourcePropertyAreaId: source.propertyAreaId,
        targetPropertyAreaId: target.propertyAreaId,
        sourceName: source.propertyArea.name,
        targetName: target.propertyArea.name,
        ...result,
        reason: input.reason ?? null,
      });
      return result;
    }, ADMIN_TRANSACTION_OPTIONS);
    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    return { ...summary, areas: await this.inspectionAreas(user, inspectionId) };
  }

  private assertReviewable(status: InspectionStatus) {
    if (FROZEN_INSPECTION_STATUSES.includes(status))
      throw new ApplicationError(
        409,
        'INSPECTION_FINALIZED',
        'A completed or cancelled inspection cannot be changed.',
      );
    if (!REVIEWABLE_INSPECTION_STATUSES.includes(status))
      throw new ApplicationError(
        409,
        'INSPECTION_NOT_REVIEWABLE',
        'Only an inspection the technician has submitted can enter the review workflow.',
      );
  }

  private async transitionReview(
    user: AuthenticatedUser,
    id: string,
    opts: {
      status: InspectionStatus;
      action: string;
      data: Prisma.InspectionUpdateInput;
      metadata: object;
    },
  ) {
    const existing = await this.requireInspection(user.organizationId, id);
    this.assertReviewable(existing.status);
    await this.prisma.$transaction(async (tx) => {
      await tx.inspection.update({
        where: { id },
        data: { status: opts.status, ...opts.data },
      });
      await this.audit(tx, user, opts.action, id, opts.metadata);
    }, ADMIN_TRANSACTION_OPTIONS);
    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
  }

  async assign(user: AuthenticatedUser, inspectionId: string, input: AssignmentDto) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const replay = await this.assignmentReplay(tx, user, inspectionId, input);
      if (replay) return { assignment: replay, shouldNotify: false };
      const inspection = await this.requireInspection(user.organizationId, inspectionId, tx);
      this.requireAssignableInspection(inspection.status);
      const current = await tx.inspectionAssignment.findFirst({
        where: { inspectionId, isCurrent: true },
      });
      if (current)
        throw new ApplicationError(
          409,
          'INSPECTION_ALREADY_ASSIGNED',
          'This inspection already has a current assignment.',
        );
      const assignment = await this.createAssignment(
        tx,
        user,
        inspectionId,
        input.technicianId,
        input.idempotencyKey,
        input.reason,
      );
      await this.audit(tx, user, 'INSPECTION_ASSIGNED', inspectionId, {
        assignmentId: assignment.id,
        technicianId: input.technicianId,
      });
      return { assignment, shouldNotify: true };
    }, ADMIN_TRANSACTION_OPTIONS);
    if (outcome.shouldNotify) {
      this.technicianEvents?.publish(input.technicianId, inspectionId, 'ASSIGNED');
      this.notifyAssignmentByEmail(user.organizationId, inspectionId, input.technicianId);
    }
    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    return outcome.assignment;
  }

  async reassign(user: AuthenticatedUser, inspectionId: string, input: AssignmentDto) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const replay = await this.assignmentReplay(tx, user, inspectionId, input);
      if (replay) return { assignment: replay, previousTechnicianId: null, shouldNotify: false };
      const inspection = await this.requireInspection(user.organizationId, inspectionId, tx);
      this.requireAssignableInspection(inspection.status);
      const current = await tx.inspectionAssignment.findFirst({
        where: { inspectionId, isCurrent: true },
      });
      if (!current)
        throw new ApplicationError(
          409,
          'NO_CURRENT_ASSIGNMENT',
          'This inspection is not currently assigned.',
        );
      if (current.technicianId === input.technicianId)
        throw new ApplicationError(409, 'SAME_TECHNICIAN', 'Select a different technician.');
      await this.requireTechnician(user.organizationId, input.technicianId, tx);
      await tx.inspectionAssignment.update({
        where: { id: current.id },
        data: {
          isCurrent: false,
          status: 'REASSIGNED',
          endedAt: new Date(),
          endedById: user.id,
          reason: input.reason,
        },
      });
      const next = await tx.inspectionAssignment.create({
        data: {
          inspectionId,
          technicianId: input.technicianId,
          assignedById: user.id,
          supersedesId: current.id,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        },
        include: { technician: { select: { id: true, displayName: true, email: true } } },
      });
      await this.audit(tx, user, 'INSPECTION_REASSIGNED', inspectionId, {
        previousAssignmentId: current.id,
        assignmentId: next.id,
        technicianId: input.technicianId,
        reason: input.reason,
      });
      return {
        assignment: next,
        previousTechnicianId: current.technicianId,
        shouldNotify: true,
      };
    }, ADMIN_TRANSACTION_OPTIONS);
    if (outcome.shouldNotify) {
      if (outcome.previousTechnicianId)
        this.technicianEvents?.publish(outcome.previousTechnicianId, inspectionId, 'REASSIGNED');
      this.technicianEvents?.publish(input.technicianId, inspectionId, 'ASSIGNED');
      this.notifyAssignmentByEmail(user.organizationId, inspectionId, input.technicianId);
    }
    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    return outcome.assignment;
  }

  async unassign(user: AuthenticatedUser, inspectionId: string, input: UnassignDto) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const inspection = await this.requireInspection(user.organizationId, inspectionId, tx);
      this.requireAssignableInspection(inspection.status);
      const current = await tx.inspectionAssignment.findFirst({
        where: { inspectionId, isCurrent: true },
      });
      if (!current)
        throw new ApplicationError(
          409,
          'NO_CURRENT_ASSIGNMENT',
          'This inspection is not currently assigned.',
        );
      const ended = await tx.inspectionAssignment.update({
        where: { id: current.id },
        data: {
          isCurrent: false,
          status: 'UNASSIGNED',
          endedAt: new Date(),
          endedById: user.id,
          reason: input.reason,
        },
      });
      await this.audit(tx, user, 'INSPECTION_UNASSIGNED', inspectionId, {
        assignmentId: current.id,
        reason: input.reason,
      });
      return { assignment: ended, technicianId: current.technicianId };
    }, ADMIN_TRANSACTION_OPTIONS);
    this.technicianEvents?.publish(outcome.technicianId, inspectionId, 'UNASSIGNED');
    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    return outcome.assignment;
  }

  async assignments(user: AuthenticatedUser, query: AssignmentListQueryDto) {
    const assignmentWhere: Prisma.InspectionAssignmentWhereInput = {
      inspection: {
        organizationId: user.organizationId,
        ...(query.inspectionId ? { id: query.inspectionId } : {}),
        ...(query.propertyId ? { propertywareBuildingId: query.propertyId } : {}),
        ...(query.inspectionStatus ? { status: query.inspectionStatus as InspectionStatus } : {}),
      },
      ...(query.technicianId ? { technicianId: query.technicianId } : {}),
      // Only assignments actually in force, unless history is asked for. A
      // reassignment leaves the previous row behind; listing it beside the new
      // one showed two technicians on one inspection and disagreed with the
      // mobile app, which has always filtered on isCurrent.
      ...(query.includeSuperseded === 'true' ? {} : { isCurrent: true }),
      ...(query.assignmentStatus && query.assignmentStatus !== 'UNASSIGNED'
        ? { status: query.assignmentStatus }
        : {}),
      ...(query.from || query.to
        ? {
            assignedAt: {
              gte: query.from ? new Date(query.from) : undefined,
              lte: query.to ? new Date(query.to) : undefined,
            },
          }
        : {}),
    };
    const inspectionSelect = {
      id: true,
      status: true,
      inspectionType: true,
      priority: true,
      scheduledAt: true,
      createdAt: true,
      updatedAt: true,
      internalNotes: true,
      propertywareBuilding: {
        select: { id: true, name: true, addressLine1: true, city: true, state: true },
      },
      propertywareUnit: { select: { id: true, name: true } },
      assignments: {
        where: { isCurrent: true },
        select: {
          id: true,
          inspectionId: true,
          technicianId: true,
          assignedById: true,
          status: true,
          isCurrent: true,
          assignedAt: true,
          endedAt: true,
          reason: true,
        },
      },
    } satisfies Prisma.InspectionSelect;
    const assignmentSelect = {
      id: true,
      inspectionId: true,
      technicianId: true,
      assignedById: true,
      status: true,
      isCurrent: true,
      assignedAt: true,
      endedAt: true,
      reason: true,
      technician: { select: { id: true, displayName: true, email: true, isActive: true } },
      assignedBy: { select: { id: true, displayName: true } },
      inspection: { select: inspectionSelect },
    } satisfies Prisma.InspectionAssignmentSelect;
    const unassignedWhere: Prisma.InspectionWhereInput = {
      organizationId: user.organizationId,
      ...(query.inspectionId ? { id: query.inspectionId } : {}),
      assignments: { none: { isCurrent: true } },
      ...(query.propertyId ? { propertywareBuildingId: query.propertyId } : {}),
      ...(query.inspectionStatus ? { status: query.inspectionStatus as InspectionStatus } : {}),
    };
    const offset = (query.page - 1) * query.pageSize;
    const includeAssignments = query.assignmentStatus !== 'UNASSIGNED';
    const includeUnassigned =
      query.includeUnassigned !== 'false' &&
      !query.technicianId &&
      (!query.assignmentStatus || query.assignmentStatus === 'UNASSIGNED');
    const candidateTake = offset + query.pageSize;
    const [assignments, assignmentTotal, unassigned, unassignedTotal] = await Promise.all([
      includeAssignments
        ? this.prisma.inspectionAssignment.findMany({
            relationLoadStrategy: 'join',
            where: assignmentWhere,
            orderBy: { assignedAt: 'desc' },
            skip: query.assignmentStatus ? offset : 0,
            take: query.assignmentStatus ? query.pageSize : candidateTake,
            select: assignmentSelect,
          })
        : [],
      includeAssignments ? this.prisma.inspectionAssignment.count({ where: assignmentWhere }) : 0,
      includeUnassigned
        ? this.prisma.inspection.findMany({
            relationLoadStrategy: 'join',
            where: unassignedWhere,
            orderBy: { createdAt: 'desc' },
            skip: query.assignmentStatus === 'UNASSIGNED' ? offset : 0,
            take: query.assignmentStatus === 'UNASSIGNED' ? query.pageSize : candidateTake,
            select: inspectionSelect,
          })
        : [],
      includeUnassigned ? this.prisma.inspection.count({ where: unassignedWhere }) : 0,
    ]);
    const assignmentItems = assignments.map((assignment) => ({
      ...assignment,
      recordType: 'ASSIGNMENT' as const,
    }));
    const unassignedItems = unassigned.map((inspection) => ({
      id: `unassigned:${inspection.id}`,
      inspectionId: inspection.id,
      recordType: 'UNASSIGNED_INSPECTION' as const,
      technicianId: null,
      assignedById: null,
      status: 'UNASSIGNED',
      isCurrent: false,
      assignedAt: null,
      endedAt: null,
      reason: null,
      technician: null,
      assignedBy: null,
      inspection,
    }));
    const items = query.assignmentStatus
      ? [...assignmentItems, ...unassignedItems]
      : [...assignmentItems, ...unassignedItems]
          .sort((left, right) => {
            const leftDate = left.assignedAt ?? left.inspection.createdAt;
            const rightDate = right.assignedAt ?? right.inspection.createdAt;
            return rightDate.getTime() - leftDate.getTime();
          })
          .slice(offset, offset + query.pageSize);
    return this.page(items, assignmentTotal + unassignedTotal, query);
  }

  async technicians(user: AuthenticatedUser, query: TechnicianListQueryDto) {
    return this.cacheRead({
      resource: 'technicians',
      scope: user.organizationId,
      query,
      loader: () => this.loadTechnicians(user, query),
    });
  }

  private async loadTechnicians(user: AuthenticatedUser, query: TechnicianListQueryDto) {
    const where: Prisma.UserProfileWhereInput = {
      memberships: {
        some: { organizationId: user.organizationId, role: UserRole.INSPECTION_TECHNICIAN },
      },
      ...(query.active !== undefined ? { isActive: query.active === 'true' } : {}),
      ...(query.search
        ? {
            OR: [
              { displayName: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [profiles, total] = await Promise.all([
      this.prisma.userProfile.findMany({
        where,
        orderBy: { displayName: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          email: true,
          displayName: true,
          isActive: true,
          createdAt: true,
        },
      }),
      this.prisma.userProfile.count({ where }),
    ]);
    const technicianIds = profiles.map((profile) => profile.id);
    const workloadWhere = {
      technicianId: { in: technicianIds },
      inspection: { organizationId: user.organizationId },
    } satisfies Prisma.InspectionAssignmentWhereInput;
    const [currentGroups, inProgressGroups, completedGroups] = technicianIds.length
      ? await Promise.all([
          this.prisma.inspectionAssignment.groupBy({
            by: ['technicianId'],
            where: { ...workloadWhere, isCurrent: true },
            _count: { _all: true },
          }),
          this.prisma.inspectionAssignment.groupBy({
            by: ['technicianId'],
            where: {
              ...workloadWhere,
              isCurrent: true,
              inspection: {
                organizationId: user.organizationId,
                status: InspectionStatus.IN_PROGRESS,
              },
            },
            _count: { _all: true },
          }),
          this.prisma.inspectionAssignment.groupBy({
            by: ['technicianId'],
            where: {
              ...workloadWhere,
              inspection: {
                organizationId: user.organizationId,
                status: InspectionStatus.COMPLETED,
              },
            },
            _count: { _all: true },
          }),
        ])
      : [[], [], []];
    const counts = (groups: Array<{ technicianId: string; _count: { _all: number } }>) =>
      new Map(groups.map((group) => [group.technicianId, group._count._all]));
    const current = counts(currentGroups);
    const inProgress = counts(inProgressGroups);
    const completed = counts(completedGroups);
    const items = profiles.map((profile) => ({
      ...profile,
      workload: {
        current: current.get(profile.id) ?? 0,
        inProgress: inProgress.get(profile.id) ?? 0,
        completed: completed.get(profile.id) ?? 0,
      },
    }));
    return this.page(items, total, query);
  }

  async technician(user: AuthenticatedUser, id: string) {
    const technician = await this.prisma.userProfile.findFirst({
      relationLoadStrategy: 'join',
      where: {
        id,
        memberships: {
          some: { organizationId: user.organizationId, role: UserRole.INSPECTION_TECHNICIAN },
        },
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        isActive: true,
        createdAt: true,
        _count: { select: { assignments: { where: { isCurrent: true } } } },
      },
    });
    if (!technician)
      throw new ApplicationError(404, 'TECHNICIAN_NOT_FOUND', 'Technician was not found.');
    const { _count, ...profile } = technician;
    return {
      ...profile,
      workload: {
        current: _count.assignments,
      },
    };
  }

  async updateTechnicianStatus(user: AuthenticatedUser, id: string, input: TechnicianStatusDto) {
    await this.requireTechnician(user.organizationId, id, this.prisma, false);
    if (!input.isActive) {
      const activeAssignments = await this.prisma.inspectionAssignment.count({
        where: { technicianId: id, isCurrent: true },
      });
      if (activeAssignments > 0)
        throw new ApplicationError(
          409,
          'TECHNICIAN_HAS_ACTIVE_ASSIGNMENTS',
          'Reassign or unassign current work before deactivating this technician.',
        );
    }
    const profile = await this.prisma.userProfile.update({
      where: { id },
      data: { isActive: input.isActive },
    });
    await this.audit(
      this.prisma,
      user,
      input.isActive ? 'TECHNICIAN_ACTIVATED' : 'TECHNICIAN_DEACTIVATED',
      id,
      {},
      'UserProfile',
    );
    await this.cacheInvalidation?.publish({
      type: 'technician.changed',
      organizationId: user.organizationId,
      technicianId: id,
    });
    return profile;
  }

  providerStatus() {
    return this.cacheRead({
      resource: 'providerReadiness',
      scope: 'global',
      query: { view: 'admin' },
      loader: async () => ({
        providers: this.providerStatuses(),
        checkedAt: new Date().toISOString(),
      }),
    });
  }

  private providerStatuses() {
    const status = (configured: boolean, ready = configured) =>
      configured ? (ready ? 'READY' : 'DEGRADED') : 'NOT_CONFIGURED';
    const cacheStatus = this.cache?.status();
    return [
      {
        provider: 'Propertyware',
        status: status(
          Boolean(
            process.env.PROPERTYWARE_CLIENT_ID &&
            process.env.PROPERTYWARE_CLIENT_SECRET &&
            process.env.PROPERTYWARE_ORGANIZATION_ID,
          ),
        ),
      },
      // There is no Supabase row either. The database is dockerized Postgres
      // and authentication is our own credential store, so a row here could
      // only ever report red for a vendor this deployment no longer uses.
      //
      // There is no Deepgram row, because nothing in this codebase calls
      // Deepgram.
      //
      // This used to report green whenever DEEPGRAM_API_KEY was set, which is
      // how somebody adds a Deepgram key, sees a healthy transcription
      // provider, and still never gets a transcript. Transcription runs on
      // OpenAI (`gpt-4o-mini-transcribe`, falling back to `whisper-1`) using
      // the key from Settings → AI operations — a database record, not an
      // environment variable — so this env-only panel cannot honestly report
      // it at all. Same mistake, and same fix, as the Cloudflare Stream row
      // removed below.
      { provider: 'Anthropic', status: status(Boolean(process.env.ANTHROPIC_API_KEY)) },
      { provider: 'OpenAI', status: status(Boolean(process.env.OPENAI_API_KEY)) },
      // Room video. Restored after being removed on the belief that "nothing in
      // the codebase calls Stream — video goes to R2". That was true once and is
      // not now: uploads go device → Stream over tus, and playback is a signed
      // customer-<code>.cloudflarestream.com URL this backend mints.
      //
      // Its own module owns the definition of "ready" (see
      // cloudflareStreamReadiness) so this panel cannot drift from it a third
      // time.
      cloudflareStreamReadiness(),
      // Photos and their resized variants. Not room video, which is the line
      // the previous version of this panel blurred.
      mediaStorageReadiness(status),
      // There is no Sentry row. Nothing imports @sentry or reads SENTRY_DSN
      // anywhere else in this codebase, so the row could only ever report on
      // whether a variable was set — green for an error reporter that does not
      // exist. Exactly the Deepgram failure described above.
      {
        provider: 'Redis',
        status: status(cacheStatus?.enabled ?? false, cacheStatus?.state === 'connected'),
        detail: cacheStatus?.state ?? 'disabled',
      },
      this.mailer?.readiness() ?? {
        provider: 'Mailer',
        status: 'NOT_CONFIGURED' as const,
        detail: 'Microsoft Graph mail service is unavailable.',
      },
    ];
  }

  private cacheRead<T>(options: CacheReadOptions<T>) {
    return this.cache ? this.cache.getOrLoad(options) : options.loader();
  }

  /**
   * Emails the technician that an inspection is theirs.
   *
   * Fire-and-forget, after the transaction has committed. Two reasons it must
   * not be awaited inside one: Microsoft Graph is a network call to a third
   * party, and holding a database transaction open across it is how a slow
   * mailbox becomes a lock-timeout on the assignment itself; and an assignment
   * that succeeded must not be rolled back because an email bounced.
   *
   * The socket event and the push already cover a running app. This is for the
   * technician who has not opened it since Friday.
   */
  private notifyAssignmentByEmail(organizationId: string, inspectionId: string, technicianId: string) {
    if (!this.mailer) return;
    void (async () => {
      try {
        const [technician, inspection] = await Promise.all([
          this.prisma.userProfile.findUnique({
            where: { id: technicianId },
            select: { email: true, displayName: true, isActive: true },
          }),
          this.prisma.inspection.findFirst({
            where: { id: inspectionId, organizationId },
            select: {
              inspectionType: true,
              scheduledAt: true,
              propertywareBuilding: { select: { name: true, addressLine1: true } },
              propertywareUnit: { select: { name: true } },
            },
          }),
        ]);
        if (!technician?.email || !technician.isActive || !inspection) return;
        await this.mailer!.sendInspectionAssignment({
          to: technician.email,
          displayName: technician.displayName,
          propertyLabel:
            inspection.propertywareBuilding?.name ??
            inspection.propertywareBuilding?.addressLine1 ??
            'an assigned property',
          unitLabel: inspection.propertywareUnit?.name ?? null,
          inspectionType: inspection.inspectionType,
          scheduledAt: inspection.scheduledAt,
        });
      } catch {
        // Best effort. The assignment stands; realtime and push already fired.
      }
    })();
  }

  private async createAssignment(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    inspectionId: string,
    technicianId: string,
    idempotencyKey?: string,
    reason?: string,
  ) {
    await this.requireTechnician(user.organizationId, technicianId, tx);
    return tx.inspectionAssignment.create({
      data: { inspectionId, technicianId, assignedById: user.id, idempotencyKey, reason },
      include: { technician: { select: { id: true, displayName: true, email: true } } },
    });
  }

  private async assignmentReplay(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    inspectionId: string,
    input: AssignmentDto,
  ) {
    if (!input.idempotencyKey) return null;
    const existing = await tx.inspectionAssignment.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: {
        inspection: { select: { organizationId: true } },
        technician: { select: { id: true, displayName: true, email: true } },
      },
    });
    if (!existing) return null;
    if (
      existing.inspection.organizationId !== user.organizationId ||
      existing.inspectionId !== inspectionId ||
      existing.technicianId !== input.technicianId
    )
      throw new ApplicationError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'This assignment request key has already been used.',
      );
    return existing;
  }

  private async requireTechnician(
    organizationId: string,
    id: string,
    tx: Prisma.TransactionClient | PrismaService,
    active = true,
  ) {
    const technician = await tx.userProfile.findFirst({
      where: {
        id,
        ...(active ? { isActive: true } : {}),
        memberships: { some: { organizationId, role: UserRole.INSPECTION_TECHNICIAN } },
      },
      select: { id: true },
    });
    if (!technician)
      throw new ApplicationError(
        422,
        'INVALID_ACTIVE_TECHNICIAN',
        'Select an active inspection technician.',
      );
    return technician;
  }

  private async requireBuilding(
    organizationId: string,
    id: string,
    active: boolean,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const property = await tx.propertywareBuilding.findFirst({
      where: {
        id,
        organizationId,
        ...(active ? { isActive: true, ...PORTFOLIO_VISIBLE } : {}),
      },
      select: {
        id: true,
        externalId: true,
        name: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        postalCode: true,
        portfolio: { select: { name: true } },
      },
    });
    if (!property)
      throw new ApplicationError(
        422,
        'INVALID_ACTIVE_PROPERTY',
        'Select an active synchronized property.',
      );
    return property;
  }

  async inspectionMedia(user: AuthenticatedUser, inspectionId: string) {
    await this.requireInspection(user.organizationId, inspectionId);
    const records = await this.prisma.inspectionMedia.findMany({
      relationLoadStrategy: 'join',
      where: { inspectionId, organizationId: user.organizationId },
      take: 100,
      // Primary walkthrough first, then additional labeled videos.
      orderBy: [{ inspectionAreaId: 'asc' }, { recordingType: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        inspectionAreaId: true,
        storageKey: true,
        mimeType: true,
        durationSeconds: true,
        recordingType: true,
        label: true,
        category: true,
        uploadStatus: true,
        processingStatus: true,
        createdAt: true,
        inspectionArea: {
          select: {
            completionStatus: true,
            propertyArea: { select: { name: true, floor: { select: { name: true } } } },
          },
        },
        technician: { select: { displayName: true } },
      },
    });
    // Poster frames are signed in parallel; for R2 this is local crypto with no
    // network round trip. A video still being processed has none yet, so the
    // player simply renders without a poster.
    const thumbnailUrls = await Promise.all(
      records.map((record) =>
        this.mediaStorage
          ? // No bucket key means a Stream-backed recording, whose thumbnail
            // comes from Cloudflare rather than from a derived R2 object.
            record.storageKey
            ? this.mediaStorage.signedUrl(thumbnailKeyFor(record.storageKey)).catch(() => null)
            : Promise.resolve(null)
          : Promise.resolve(null),
      ),
    );
    return records.map((record, index) => ({
      id: record.id,
      roomId: record.inspectionAreaId,
      roomName: record.inspectionArea.propertyArea.name,
      floorName: record.inspectionArea.propertyArea.floor?.name ?? null,
      roomCompletionStatus: record.inspectionArea.completionStatus,
      technicianName: record.technician.displayName,
      mimeType: record.mimeType,
      durationSeconds: record.durationSeconds,
      recordingType: record.recordingType,
      label: record.label,
      category: record.category,
      uploadStatus: record.uploadStatus,
      processingStatus: record.processingStatus,
      createdAt: record.createdAt,
      contentPath: `/api/v1/admin/media/${record.id}/content`,
      thumbnailUrl: thumbnailUrls[index],
    }));
  }

  async mediaContent(user: AuthenticatedUser, mediaId: string) {
    if (!this.mediaStorage)
      throw new ApplicationError(
        503,
        'INSPECTION_MEDIA_STORAGE_NOT_CONFIGURED',
        'Inspection media storage is not configured.',
      );
    const record = await this.prisma.inspectionMedia.findFirst({
      where: { id: mediaId, organizationId: user.organizationId },
      select: { id: true, providerMediaId: true, storageKey: true, mimeType: true },
    });
    if (!record)
      throw new ApplicationError(404, 'INSPECTION_MEDIA_NOT_FOUND', 'Room video not found.');
    // The legacy proxy path, kept for recordings that predate Stream. A
    // Stream-backed video has no bucket object and must not be streamed through
    // this backend at all — that round trip is the bottleneck Stream replaces.
    if (!record.storageKey)
      throw new ApplicationError(
        409,
        'MEDIA_NOT_PROXYABLE',
        'This recording is served by Cloudflare Stream. Request a playback URL instead.',
      );
    return {
      bytes: await this.mediaStorage.get(record.storageKey),
      mimeType: record.mimeType,
      fileName: `room-video-${record.id}.mp4`,
    };
  }

  /**
   * A short-lived URL the browser can stream directly from the storage CDN.
   * Direct streaming supports range requests, so reviewers can seek without
   * downloading the whole file, and the API never proxies video bytes.
   *
   * Returns `{ url: null }` for the local backend, where the caller must fall
   * back to the byte-proxying content endpoint.
   */
  async mediaPlaybackUrl(user: AuthenticatedUser, mediaId: string) {
    if (!this.mediaStorage)
      throw new ApplicationError(
        503,
        'INSPECTION_MEDIA_STORAGE_NOT_CONFIGURED',
        'Inspection media storage is not configured.',
      );
    const record = await this.prisma.inspectionMedia.findFirst({
      where: { id: mediaId, organizationId: user.organizationId },
      select: { id: true, storageKey: true, mimeType: true },
    });
    if (!record)
      throw new ApplicationError(404, 'INSPECTION_MEDIA_NOT_FOUND', 'Room video not found.');
    if (!record.storageKey)
      throw new ApplicationError(
        409,
        'MEDIA_NOT_PROXYABLE',
        'This recording is served by Cloudflare Stream. Request a playback URL instead.',
      );
    const expiresInSeconds = 900;
    const url = await this.mediaStorage.signedUrl(record.storageKey, expiresInSeconds);
    return {
      url,
      mimeType: record.mimeType,
      expiresAt: url ? new Date(Date.now() + expiresInSeconds * 1000).toISOString() : null,
    };
  }

  async inspectionPhotos(user: AuthenticatedUser, inspectionId: string) {
    await this.requireInspection(user.organizationId, inspectionId);
    const records = await this.prisma.inspectionPhoto.findMany({
      relationLoadStrategy: 'join',
      where: { inspectionId, organizationId: user.organizationId },
      orderBy: [
        { inspectionAreaId: 'asc' },
        { captureType: 'asc' },
        { sequenceNumber: 'asc' },
        { createdAt: 'asc' },
      ],
      take: 500,
      select: {
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
        inspectionArea: { select: { propertyArea: { select: { name: true } } } },
      },
    });
    return records.map((record) => ({
      id: record.id,
      roomId: record.inspectionAreaId,
      roomName: record.inspectionArea.propertyArea.name,
      findingId: record.findingId,
      captureType: record.captureType,
      sequenceNumber: record.sequenceNumber,
      label: record.label,
      notes: record.notes,
      mimeType: record.mimeType,
      width: record.width,
      height: record.height,
      capturedByName: record.capturedBy.displayName,
      capturedAt: record.capturedAt.toISOString(),
      contentPath: `/api/v1/admin/photos/${record.id}/content`,
    }));
  }

  /**
   * Photo bytes for the administrator UI.
   *
   * `width` requests a bounded variant (see ALLOWED_PHOTO_WIDTHS), cached
   * beside the original under a derived key so the re-encode happens once per
   * photo rather than once per view. Galleries must always ask for a width:
   * loading originals for every thumbnail is what made the evidence page
   * download tens of megabytes before showing anything.
   */
  async photoContent(user: AuthenticatedUser, photoId: string, width?: number) {
    if (!this.mediaStorage)
      throw new ApplicationError(
        503,
        'INSPECTION_MEDIA_STORAGE_NOT_CONFIGURED',
        'Inspection media storage is not configured.',
      );
    const record = await this.prisma.inspectionPhoto.findFirst({
      where: { id: photoId, organizationId: user.organizationId },
      select: { id: true, storageKey: true, mimeType: true },
    });
    if (!record)
      throw new ApplicationError(404, 'INSPECTION_PHOTO_NOT_FOUND', 'Photo was not found.');
    if (width === undefined || !isAllowedPhotoWidth(width))
      return {
        bytes: await this.mediaStorage.get(record.storageKey),
        mimeType: record.mimeType,
        fileName: `photo-${record.id}`,
      };
    const variantKey = resizedPhotoKeyFor(record.storageKey, width);
    try {
      return {
        bytes: await this.mediaStorage.get(variantKey),
        mimeType: 'image/jpeg',
        fileName: `photo-${record.id}-w${width}`,
      };
    } catch {
      // Not generated yet.
    }
    const original = await this.mediaStorage.get(record.storageKey);
    const resized = await resizeImage(original, width);
    // A failed cache write must not fail the request; the bytes are already in
    // hand and the next view simply re-encodes.
    await this.mediaStorage.putBytes(variantKey, resized, 'image/jpeg').catch(() => undefined);
    return { bytes: resized, mimeType: 'image/jpeg', fileName: `photo-${record.id}-w${width}` };
  }

  async findings(user: AuthenticatedUser, inspectionId: string, query: AdminFindingsQueryDto) {
    await this.requireInspection(user.organizationId, inspectionId);
    const where = {
      inspectionId,
      inspection: { organizationId: user.organizationId },
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
        orderBy: { createdAt: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          inspectionId: true,
          propertyAreaId: true,
          inspectionMediaId: true,
          findingType: true,
          category: true,
          title: true,
          description: true,
          baselineCondition: true,
          comparisonResult: true,
          videoTimestampStart: true,
          videoTimestampEnd: true,
          severity: true,
          possibleResponsibility: true,
          confidence: true,
          recommendedReview: true,
          reviewStatus: true,
          createdAt: true,
          propertyArea: { select: { name: true } },
          reviews: {
            orderBy: { createdAt: 'desc' as const },
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
      this.prisma.inspectionFinding.count({ where }),
    ]);
    return this.page(
      records.map((record) => ({
        id: record.id,
        inspectionId: record.inspectionId,
        roomId: record.propertyAreaId,
        roomName: record.propertyArea.name,
        mediaId: record.inspectionMediaId,
        findingType: record.findingType,
        category: record.category,
        title: record.title,
        description: record.description,
        baselineCondition: record.baselineCondition,
        comparisonResult: record.comparisonResult,
        videoTimestampStart: record.videoTimestampStart,
        videoTimestampEnd: record.videoTimestampEnd,
        severity: record.severity,
        possibleResponsibility: record.possibleResponsibility,
        confidence: record.confidence,
        recommendedReview: record.recommendedReview,
        reviewStatus: record.reviewStatus,
        createdAt: record.createdAt,
        lastReview: record.reviews[0]
          ? {
              status: record.reviews[0].status,
              reason: record.reviews[0].reason,
              reviewerName: record.reviews[0].reviewer.displayName,
              createdAt: record.reviews[0].createdAt,
            }
          : null,
      })),
      total,
      query,
    );
  }

  async reviewFinding(
    user: AuthenticatedUser,
    findingId: string,
    status: 'APPROVED' | 'REJECTED',
    reason?: string,
  ) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const finding = await tx.inspectionFinding.findFirst({
        where: { id: findingId, inspection: { organizationId: user.organizationId } },
        select: { id: true, inspectionId: true, reviewStatus: true },
      });
      if (!finding) throw new ApplicationError(404, 'FINDING_NOT_FOUND', 'Finding was not found.');
      const nextStatus =
        status === 'APPROVED' ? FindingReviewStatus.APPROVED : FindingReviewStatus.REJECTED;
      // Re-sending the same decision is a no-op so review clicks are idempotent.
      if (finding.reviewStatus === nextStatus) return { finding, review: null };
      const review = await tx.findingReview.create({
        data: { findingId: finding.id, reviewerId: user.id, status: nextStatus, reason },
      });
      const updated = await tx.inspectionFinding.update({
        where: { id: finding.id },
        data: { reviewStatus: nextStatus },
        select: { id: true, inspectionId: true, reviewStatus: true },
      });
      await this.audit(
        tx,
        user,
        status === 'APPROVED' ? 'FINDING_APPROVED' : 'FINDING_REJECTED',
        finding.id,
        { inspectionId: finding.inspectionId, reason: reason ?? null, reviewId: review.id },
        'InspectionFinding',
      );
      return { finding: updated, review };
    }, ADMIN_TRANSACTION_OPTIONS);
    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    return outcome.finding;
  }

  /**
   * Permanently erase an inspection and everything hanging off it.
   *
   * Gated on `inspections:delete`, which is deliberately its own permission
   * rather than part of `inspections:manage`: managing an inspection means
   * editing and cancelling it, and cancelling is the reversible, auditable way
   * to close one. This is the irreversible one, so it can be withheld from the
   * same people who are trusted to run the rest of the workflow.
   *
   * Unlike every other mutation here it does **not** refuse a finalized
   * inspection. `finalizedAt` freezes evidence against edits — a technician
   * cannot delete a photo out of a closed report — but that guard exists to stop
   * a report being quietly altered, not to make a whole inspection immortal.
   * Deleting one removes the report entirely, which is a different act, and the
   * permission is the gate on it.
   *
   * Ordering is dictated by the schema, not by preference. Most children of
   * `Inspection` have no `onDelete: Cascade`, so a bare `inspection.delete()`
   * fails on the first foreign key. Each step below removes a table that points
   * at something deleted later; the ones that *do* cascade
   * (`AreaEvidenceRequest`, `InspectionAreaChecklistResponse`) are left to the
   * database.
   */
  async deleteInspection(user: AuthenticatedUser, id: string) {
    const result = await this.eraseInspection(user, id);
    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    return { deleted: true, ...result };
  }

  /**
   * Delete several inspections in one request.
   *
   * Each one runs in **its own transaction**, sequentially, rather than all of
   * them in a single outer transaction. Two reasons, both learned the hard way
   * on this codebase:
   *
   * - A batch that wraps everything scales its statement count with the data,
   *   and the remote pooler drops it at five seconds with "Transaction not
   *   found". Deleting twenty inspections' worth of media in one transaction is
   *   exactly that shape.
   * - For clearing test data, partial success beats all-or-nothing. One
   *   inspection that refuses — because a dependant could not be unlinked, say —
   *   should not strip the other nineteen of a successful delete they already
   *   earned.
   *
   * So the response reports per-id outcomes and the caller decides what to
   * retry. Nothing is silently skipped.
   */
  async deleteInspections(user: AuthenticatedUser, ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.length > MAX_BULK_DELETE)
      throw new ApplicationError(
        422,
        'TOO_MANY_INSPECTIONS',
        `Delete at most ${MAX_BULK_DELETE} inspections at a time.`,
      );

    const deleted: string[] = [];
    const failed: { id: string; message: string }[] = [];
    let orphanedStorageObjects = 0;

    for (const id of unique) {
      try {
        const result = await this.eraseInspection(user, id);
        orphanedStorageObjects += result.orphanedStorageObjects;
        deleted.push(id);
      } catch (error) {
        failed.push({
          id,
          message:
            error instanceof ApplicationError
              ? error.message
              : 'This inspection could not be deleted.',
        });
      }
    }

    // Published once, not per inspection: twenty deletes are one change to the
    // list every client is looking at.
    if (deleted.length)
      await this.cacheInvalidation?.publish({
        type: 'inspection.changed',
        organizationId: user.organizationId,
      });

    return { requested: unique.length, deleted, failed, orphanedStorageObjects };
  }

  /**
   * The deletion itself, shared by the single and bulk endpoints so there is
   * one implementation of an irreversible operation rather than two that drift.
   * Cache invalidation is the caller's job — the bulk path publishes once.
   */
  private async eraseInspection(user: AuthenticatedUser, id: string) {
    await this.requireInspection(user.organizationId, id);

    // Read the storage identities before the rows go: once the transaction
    // commits there is nothing left to tell us which objects to remove.
    const [media, photos] = await Promise.all([
      this.prisma.inspectionMedia.findMany({
        where: { inspectionId: id },
        select: { id: true, streamUid: true, storageKey: true },
      }),
      this.prisma.inspectionPhoto.findMany({
        where: { inspectionId: id },
        select: { id: true, storageKey: true },
      }),
    ]);

    const counts = await this.prisma.$transaction(async (tx) => {
      /**
       * Dependants are unlinked rather than deleted.
       *
       * `baselineInspectionId` and `parentInspectionId` are both
       * `onDelete: Restrict`, so a move-in that some move-out compares against
       * cannot simply be removed. Clearing the pointer keeps the other
       * inspection — and all of its evidence — intact; it loses its baseline
       * comparison, which is recorded in the audit metadata below so the
       * absence is explainable later.
       */
      const [baselineOf, parentOf] = await Promise.all([
        tx.inspection.updateMany({
          where: { baselineInspectionId: id },
          data: { baselineInspectionId: null },
        }),
        tx.inspection.updateMany({
          where: { parentInspectionId: id },
          data: { parentInspectionId: null },
        }),
      ]);

      // No Prisma relation on either column, so these are matched by hand.
      // Area comparisons cascade from the comparison row.
      await tx.inspectionComparison.deleteMany({
        where: { OR: [{ moveOutInspectionId: id }, { moveInInspectionId: id }] },
      });

      // Charges reference findings and pet candidates, so they go first.
      await tx.charge.deleteMany({ where: { inspectionId: id } });
      await tx.petObservation.deleteMany({ where: { inspectionId: id } });
      await tx.petCandidate.deleteMany({ where: { inspectionId: id } });

      await tx.findingReview.deleteMany({ where: { finding: { inspectionId: id } } });
      // Photos carry a findingId as well as an area, so they precede findings.
      const deletedPhotos = await tx.inspectionPhoto.deleteMany({ where: { inspectionId: id } });

      /**
       * The three job tables that hang off a recording.
       *
       * None of them cascades, and none carries an `inspectionId` — they are
       * reachable only through `inspectionMediaId`, which is why an enumeration
       * that greps for `inspectionId` misses all three and the delete dies on
       * `AiAnalysisJob_inspectionMediaId_fkey` at the first recording.
       */
      const mediaOfInspection = { inspectionMedia: { inspectionId: id } };
      // Segments hang off the transcription job, not the media, and the
      // constraint is RESTRICT — so the job cannot go until its transcript does.
      await tx.transcriptSegment.deleteMany({
        where: { transcriptionJob: mediaOfInspection },
      });
      await tx.aiAnalysisJob.deleteMany({ where: mediaOfInspection });
      await tx.transcriptionJob.deleteMany({ where: mediaOfInspection });
      await tx.mediaProcessingEvent.deleteMany({ where: mediaOfInspection });

      /**
       * Findings before media, not after.
       *
       * `InspectionFinding.inspectionMediaId` points at the recording a finding
       * was raised from, so deleting the media first violates that constraint.
       * The reverse order is not symmetric — nothing in `InspectionMedia` points
       * back at a finding.
       */
      const deletedFindings = await tx.inspectionFinding.deleteMany({ where: { inspectionId: id } });
      const deletedMedia = await tx.inspectionMedia.deleteMany({ where: { inspectionId: id } });

      await tx.mediaUploadSession.deleteMany({
        where: { inspectionArea: { inspectionId: id } },
      });
      await tx.inspectionAreaStatusHistory.deleteMany({
        where: { inspectionArea: { inspectionId: id } },
      });
      const deletedAreas = await tx.inspectionArea.deleteMany({ where: { inspectionId: id } });
      await tx.inspectionAssignment.deleteMany({ where: { inspectionId: id } });
      await tx.inspectionReportShare.deleteMany({ where: { inspectionId: id } });
      await tx.areaEvidenceRequest.deleteMany({ where: { inspectionId: id } });

      await tx.inspection.delete({ where: { id } });

      /**
       * Written last, inside the same transaction.
       *
       * `AuditLog.entityId` is a plain string with no foreign key to
       * `Inspection`, which is what lets the record outlive the row it
       * describes — the deletion is the one event whose evidence must survive
       * the thing it happened to.
       */
      await this.audit(tx, user, 'INSPECTION_DELETED', id, {
        areas: deletedAreas.count,
        recordings: deletedMedia.count,
        photos: deletedPhotos.count,
        findings: deletedFindings.count,
        unlinkedBaselineOf: baselineOf.count,
        unlinkedParentOf: parentOf.count,
      });

      return {
        areas: deletedAreas.count,
        recordings: deletedMedia.count,
        photos: deletedPhotos.count,
        findings: deletedFindings.count,
        unlinkedInspections: baselineOf.count + parentOf.count,
      };
    });

    /**
     * Storage is cleared after the commit, never before.
     *
     * Deleting the objects first would destroy footage for an inspection that
     * still exists if the transaction then rolled back — the failure mode with
     * no recovery. This way a storage error leaves an orphan, which costs money
     * but loses nothing, and is reported rather than swallowed so somebody can
     * clean it up.
     */
    const failures: string[] = [];
    for (const item of media) {
      if (item.streamUid && this.stream)
        await this.stream.deleteVideo(item.streamUid).catch(() => failures.push(item.id));
      if (item.storageKey && this.mediaStorage)
        await this.mediaStorage.delete(item.storageKey).catch(() => failures.push(item.id));
    }
    for (const photo of photos) {
      if (this.mediaStorage)
        await this.mediaStorage.delete(photo.storageKey).catch(() => failures.push(photo.id));
    }

    return { ...counts, orphanedStorageObjects: failures.length };
  }

  private async requireInspection(
    organizationId: string,
    id: string,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const inspection = await tx.inspection.findFirst({
      where: { id, organizationId },
      select: {
        id: true,
        status: true,
        propertywareBuildingId: true,
        propertywareUnitId: true,
      },
    });
    if (!inspection)
      throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
    return inspection;
  }

  private async resolveLifecycleBaseline(
    tx: Prisma.TransactionClient,
    input: {
      organizationId: string;
      propertyId: string;
      unitId: string | null;
      leaseId: string | null;
      inspectionType: InspectionType;
      scheduledAt: Date;
    },
  ) {
    if (input.inspectionType === InspectionType.MOVE_IN) return null;
    // HVAC is equipment maintenance, not a tenancy lifecycle stage. It is
    // scheduled on its own cadence against tenanted and vacant properties
    // alike, so requiring a completed move-in — or any predecessor — would
    // block legitimate work on every property this system has not onboarded
    // through a full lease cycle.
    if (input.inspectionType === InspectionType.HVAC) return null;

    const lifecycleScope = {
      organizationId: input.organizationId,
      propertywareBuildingId: input.propertyId,
      propertywareUnitId: input.unitId,
      propertywareLeaseId: input.leaseId,
      scheduledAt: { lt: input.scheduledAt },
      completedAt: { not: null },
      status: {
        in: [
          InspectionStatus.PROCESSING,
          InspectionStatus.REVIEW_REQUIRED,
          InspectionStatus.COMPLETED,
        ],
      },
    } satisfies Prisma.InspectionWhereInput;
    const baseline = await tx.inspection.findFirst({
      where: { ...lifecycleScope, inspectionType: InspectionType.MOVE_IN },
      orderBy: { scheduledAt: 'desc' },
      select: { id: true },
    });
    if (!baseline)
      throw new ApplicationError(
        409,
        'MOVE_IN_BASELINE_REQUIRED',
        'Complete the move-in inspection for this property, unit, and lease before scheduling a later lifecycle inspection.',
      );

    const requiredPredecessor = {
      [InspectionType.OCCUPIED]: null,
      [InspectionType.BACK_TO_MARKET]: InspectionType.OCCUPIED,
      [InspectionType.MOVE_OUT]: InspectionType.BACK_TO_MARKET,
    }[input.inspectionType];
    if (requiredPredecessor) {
      const predecessor = await tx.inspection.findFirst({
        where: { ...lifecycleScope, inspectionType: requiredPredecessor },
        orderBy: { scheduledAt: 'desc' },
        select: { id: true },
      });
      if (!predecessor)
        throw new ApplicationError(
          409,
          'INSPECTION_SEQUENCE_REQUIRED',
          `Complete the ${requiredPredecessor.toLowerCase().replaceAll('_', ' ')} inspection before scheduling this inspection.`,
        );
    }
    return baseline.id;
  }

  private propertySnapshot(
    property: Awaited<ReturnType<AdminService['requireBuilding']>>,
    unit: {
      id: string;
      externalId: string;
      name: string;
      addressLine1: string | null;
      addressLine2: string | null;
      city: string | null;
      state: string | null;
      postalCode: string | null;
    } | null,
  ) {
    return {
      property: {
        id: property.id,
        externalId: property.externalId,
        name: property.name,
        addressLine1: property.addressLine1,
        addressLine2: property.addressLine2,
        city: property.city,
        state: property.state,
        postalCode: property.postalCode,
        portfolio: property.portfolio?.name ?? 'Unassigned',
      },
      unit,
    };
  }

  private requireAssignableInspection(status: InspectionStatus) {
    if (!ACTIVE_INSPECTION_STATUSES.includes(status))
      throw new ApplicationError(
        409,
        'INSPECTION_NOT_ASSIGNABLE',
        'A completed or cancelled inspection cannot be assigned.',
      );
  }

  private leaseSnapshot(lease: {
    id: string;
    externalId: string;
    leaseName: string | null;
    sourceStatus: string | null;
    startDate: Date | null;
    endDate: Date | null;
    scheduledMoveOutDate: Date | null;
  }) {
    return {
      id: lease.id,
      externalId: lease.externalId,
      leaseName: lease.leaseName,
      sourceStatus: lease.sourceStatus,
      startDate: lease.startDate,
      endDate: lease.endDate,
      scheduledMoveOutDate: lease.scheduledMoveOutDate,
    };
  }

  private audit(
    tx: Prisma.TransactionClient | PrismaService,
    user: AuthenticatedUser,
    action: string,
    entityId: string,
    metadata: object,
    entityType = 'Inspection',
  ) {
    return tx.auditLog.create({
      data: {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action,
        entityType,
        entityId,
        metadata,
      },
    });
  }

  private page<T>(items: T[], total: number, query: PaginationDto) {
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }
}
