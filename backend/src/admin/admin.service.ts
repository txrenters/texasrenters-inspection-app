import { Inject, Injectable, Optional } from '@nestjs/common';
import type { FindingRejectReason, FindingType, Severity } from '@prisma/client';
import {
  ComparisonResult,
  EvidenceRequestStatus,
  FindingReviewStatus,
  FindingSource,
  InspectionStatus,
  InspectionType,
  JobberConnectionStatus,
  JobberOutboundKind,
  JobberOutboundStatus,
  JobberVisitImportStatus,
  MediaProcessingStatus,
  Prisma,
  PropertyAreaStatus,
  ResponsibilityClassification,
  UserRole,
  VideoRecordingType,
} from '@prisma/client';

import {
  AreaScope,
  LEASE_EXPIRING_SOON_DAYS,
  SEGMENT_DEFAULTS,
  areaScopeFor,
  bookingFromTenancy,
  booksAnyService,
  daysUntilLeaseEnd,
  isBookableInspectionType,
  layoutAreasFor,
  jobberBookingProblems,
  jobberBookingText,
  leaseExpiryStatus,
  visitServicesDetails,
  visitServicesProblems,
  type JobberBookingContext,
  type JobberBookingInput,
  type VisitServicesBooking,
} from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { CacheInvalidationService } from '../cache/cache-invalidation.service';
import { CacheService, type CacheReadOptions } from '../cache/cache.service';
import { eraseInspectionRows } from '../common/erase-inspection';
import { jobInWords } from '../common/job-in-words';
import { ApplicationError } from '../common/errors';
import { moveStopWithVisit } from '../planning/move-stop-with-visit';
import { TBP_TITLE_MARKER } from '../planning/tbp-plan.service';
import { isAllowedPhotoWidth, resizeImage } from '../common/image-resizing';
import { inspectedAreaWhere } from '../common/inspected-areas';
import { DONE_INSPECTION_STATUSES, isDoneInspectionStatus } from '../common/inspection-done';
import { inspectionSearchWhere, inspectionStatusWhere } from './inspection-list-where';
import { resizedPhotoKeyFor, thumbnailKeyFor } from '../common/object-storage';
import { PrismaService } from '../common/prisma.service';
import {
  PORTFOLIO_VISIBLE,
  type InspectionPlan,
  insertInspection,
  requireBuilding,
  resolveInspectionPlan,
} from './inspection-creation';
import { assignmentPropertySearch } from './assignment-search';
import {
  DEMO_PROPERTY_LIMIT,
  DEMO_SOURCE_SYSTEM,
  demoPropertyFixture,
  nextDemoSequence,
} from './demo-property';
import { inspectionEvidenceTimes, inspectionSpan } from './inspection-timing';
import { detailsView, ownerView, privateDetails } from './property-details-view';
import { SERVICE_STATUS_VIEW_SELECT, serviceStatusView } from './property-service-status';
import { tenancyOnFile } from './tenancy-on-file';
import { jobberUserIdForEmail, linkedJobberProperty } from '../integrations/jobber/jobber.booking';
import { getJobberConfig } from '../integrations/jobber/jobber.config';
import {
  VISIT_EDIT_KINDS,
  enqueueJobberCompletion,
  requestVisitPush,
  type VisitEditKind,
} from '../integrations/jobber/jobber.outbound';
import { movedWindow } from '../common/business-day';
import { PresenceService } from '../realtime/presence.service';
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
import { baselineWhere } from './comparison.service';
import type {
  AdminFindingsQueryDto,
  AssignmentDto,
  AssignmentListQueryDto,
  AuditListQueryDto,
  CreateAdminInspectionDto,
  CreateEvidenceRequestDto,
  CompleteInspectionDto,
  FinalizeInspectionDto,
  InspectionFollowUpDto,
  InspectionListQueryDto,
  InspectionTbdDto,
  InspectionUnderReviewDto,
  JobberBookingContextQueryDto,
  LeaseListQueryDto,
  AddInspectionAreasDto,
  MergeInspectionAreasDto,
  PaginationDto,
  PortfolioListQueryDto,
  PropertyListQueryDto,
  TenantListQueryDto,
  ReopenInspectionDto,
  TechnicianListQueryDto,
  TechnicianStatusDto,
  UnassignDto,
  UnitListQueryDto,
  UpdateAdminInspectionDto,
  UpdateJobberVisitDto,
} from './admin.dto';

/** The services a visit books, by name, for an audit entry: never the Details. */
function bookedServiceNames(services: VisitServicesBooking['services']): string[] {
  return Object.entries(services)
    .filter(([, booked]) => booked)
    .map(([service]) => service);
}

/** The street address a booked visit's title starts with: the unit's, else the building's. */
function bookingAddress(
  building: { name: string; addressLine1: string | null },
  unit: { addressLine1: string | null } | null,
): string {
  return unit?.addressLine1?.trim() || building.addressLine1?.trim() || building.name;
}

function webOrigin(): string {
  return (process.env.WEB_APP_ORIGIN ?? 'http://localhost:5454').replace(/\/$/, '');
}

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

/** Still to happen -- a visit somebody has to be sent to (`isUpcomingVisit`). */
const UPCOMING_INSPECTION_STATUSES: InspectionStatus[] = ACTIVE_INSPECTION_STATUSES.filter(
  (status) => !DONE_INSPECTION_STATUSES.includes(status),
);

// An inspection can no longer transition once finalized or cancelled.
/**
 * Benefit-package enrolment as the office writes it, reduced to three answers.
 *
 * The report holds free text — `Yes`, `No`, `Not Verified` — and the third is a
 * real third answer, not a missing yes. Seventeen active tenancies carry it and
 * it means nobody has checked. Anything unrecognised also lands here rather
 * than being read as a no, because guessing against the office is how a
 * property ends up billed for a service it never had.
 */
function tbpState(value: string | null | undefined): 'ENROLLED' | 'NOT_ENROLLED' | 'NOT_VERIFIED' {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'yes') return 'ENROLLED';
  if (normalized === 'no') return 'NOT_ENROLLED';
  return 'NOT_VERIFIED';
}

/** One answer for a building, or MIXED when its tenancies disagree. */
function rollUpTbp(states: Set<string> | undefined) {
  if (!states?.size) return null;
  if (states.size > 1) return 'MIXED' as const;
  return [...states][0] as 'ENROLLED' | 'NOT_ENROLLED' | 'NOT_VERIFIED';
}

/** "Q4 2026", as the office writes a quarter. */
const quarterLabelOf = (year: number, quarter: number) => `Q${quarter} ${year}`;

/**
 * The quarter a visit belongs to, which is not always the one its day falls in.
 *
 * A quarter's plan may start fifteen days before the quarter does, so Q4's
 * first visits are scheduled in September. Read off the calendar they land in
 * Q3 — a quarter whose rule has no HVAC inspections at all — which is how 36
 * HVAC and 19 occupied visits of the Q4 plan appeared under Q3 2026 (the
 * office, 2026-09-21: "why there's an HVAC on Q3 ... forgot about the rule?").
 *
 * The plan answers first, because it is the thing that decided. A visit the
 * office booked in Jobber itself has no plan here, and its programme title
 * names the quarter — the office's own word for it. All 362 of them do.
 * Anything else is not a programme visit, and the quarter its day falls in is
 * the only meaning it has: a "Q3 2026" in some other Jobber job's title is not
 * this programme's quarter and must not be read as one.
 */
export function visitQuarter(item: {
  scheduledAt: Date;
  jobberVisitTitle?: string | null;
  tbpPlanStop?: { plan: { quarterYear: number; quarterNumber: number } } | null;
}): string {
  if (item.tbpPlanStop)
    return quarterLabelOf(item.tbpPlanStop.plan.quarterYear, item.tbpPlanStop.plan.quarterNumber);
  const title = item.jobberVisitTitle ?? '';
  const named = title.toLowerCase().includes(TBP_TITLE_MARKER)
    ? /\bQ([1-4])\s+(\d{4})\b/i.exec(title)
    : null;
  if (named) return quarterLabelOf(Number(named[2]), Number(named[1]));
  return quarterLabelOf(
    item.scheduledAt.getUTCFullYear(),
    Math.floor(item.scheduledAt.getUTCMonth() / 3) + 1,
  );
}

/** One asked-for quarter, with the days the calendar gives it. Null for anything else. */
export function quarterFilter(label: string | undefined) {
  const parsed = label ? /^Q([1-4])\s+(\d{4})$/.exec(label.trim()) : null;
  if (!parsed) return null;
  const quarter = Number(parsed[1]);
  const year = Number(parsed[2]);
  return {
    quarter,
    year,
    label: quarterLabelOf(year, quarter),
    from: new Date(Date.UTC(year, (quarter - 1) * 3, 1)),
    to: new Date(Date.UTC(year, quarter * 3, 0, 23, 59, 59, 999)),
  };
}

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

/**
 * What is stopping this inspection being finalized, in words a reviewer can act
 * on.
 *
 * Exported for its own test. The rule it encodes: say only what is actually
 * blocking, and name it. The message this replaced always printed both counts,
 * so an administrator with nothing but an unreviewable row behind the gate read
 * "1 finding(s) awaiting review and 0 recording(s) still processing" and had no
 * way to find the one or dismiss the zero.
 */
export function describeFinalizeBlockers(
  findings: readonly { title: string; propertyArea: { name: string } | null }[],
  media: readonly { inspectionArea: { propertyArea: { name: string } } | null }[],
): string {
  const parts: string[] = [];
  if (findings.length) {
    // Named rather than counted: "Kitchen — Cracked tile" is something a
    // reviewer can go and open.
    const named = findings
      .slice(0, 3)
      .map((finding) =>
        finding.propertyArea?.name
          ? `${finding.propertyArea.name} — ${finding.title}`
          : finding.title,
      )
      .join('; ');
    const rest = findings.length > 3 ? ` and ${findings.length - 3} more` : '';
    parts.push(
      `${findings.length} finding${findings.length === 1 ? '' : 's'} still awaiting review (${named}${rest})`,
    );
  }
  if (media.length) {
    const areas = [
      ...new Set(
        media
          .map((item) => item.inspectionArea?.propertyArea.name)
          .filter((name): name is string => Boolean(name)),
      ),
    ];
    parts.push(
      `${media.length} recording${media.length === 1 ? '' : 's'} still processing${
        areas.length ? ` (${areas.slice(0, 3).join(', ')})` : ''
      }`,
    );
  }
  return `${parts.join(' and ')}. Resolve ${parts.length > 1 ? 'them' : 'it'} or document an override to finalize.`;
}

/**
 * Distinguishes "not sent" from "cleared" for an optional text field.
 *
 * Returns undefined so Prisma skips the column when the caller omitted it, and
 * null when they sent it blank — which is the difference between leaving a
 * comment alone and deleting it.
 */
function emptyToNull(value: string | undefined) {
  if (value === undefined) return undefined;
  return value.trim() || null;
}

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
 * What a reviewer's finding says against the move-in, from its type. The
 * reviewer says what it is; this is only the same thing in the comparison's
 * terms, so the report and the comparison read it as they read any finding.
 */
const REVIEWER_COMPARISON: Record<FindingType, ComparisonResult> = {
  POSSIBLE_NEW_DAMAGE: ComparisonResult.POSSIBLE_NEW_DAMAGE,
  EXISTING_CONDITION: ComparisonResult.EXISTING_CONDITION,
  MAINTENANCE: ComparisonResult.OWNER_MAINTENANCE,
  NO_CHANGE: ComparisonResult.NO_MATERIAL_CHANGE,
};

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
      process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY,
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
    @Inject(PresenceService) private readonly presence: PresenceService,
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
      // Work still waiting for a technician: a submitted visit is done, and
      // needs nobody assigned to it (`DONE_INSPECTION_STATUSES`).
      this.prisma.inspection.count({
        where: {
          organizationId,
          status: {
            in: ACTIVE_INSPECTION_STATUSES.filter((status) => !DONE_INSPECTION_STATUSES.includes(status)),
          },
          assignments: { none: { isCurrent: true } },
        },
      }),
      // "Ready to begin": still to come, as "Unassigned" counts. Any current
      // assignment counted done visits, and cancelled ones still carrying a
      // technician (2026-10-07).
      this.prisma.inspection.count({
        where: {
          organizationId,
          status: { in: UPCOMING_INSPECTION_STATUSES },
          assignments: { some: { isCurrent: true } },
        },
      }),
      this.prisma.inspection.count({
        where: { organizationId, status: InspectionStatus.IN_PROGRESS },
      }),
      // Submitted is done; COMPLETED alone stopped moving once nobody finalized.
      this.prisma.inspection.count({
        where: { organizationId, status: { in: DONE_INSPECTION_STATUSES } },
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

  /**
   * Tenancies from the office s own Propertyware report.
   *
   * Not the same rows as `propertyware_leases`: that comes from the REST
   * endpoint, and this comes from the report the office maintains -- the only
   * source that knows about the benefit package, and the only one carrying a
   * building address.
   */
  async tenants(user: AuthenticatedUser, query: TenantListQueryDto) {
    const active = query.active === undefined ? true : query.active === 'true';
    const where: Prisma.PropertywareTenantWhereInput = {
      organizationId: user.organizationId,
      isActive: active,
      // Matched case-insensitively: this is a hand-maintained picklist, not an
      // enum we control, and an exact-casing equality would silently return
      // nothing the day somebody types 'yes'.
      ...(query.enrollment === 'TBP'
        ? { tbpEnrollment: { equals: 'Yes', mode: 'insensitive' as const } }
        : {}),
      ...(query.enrollment === 'NOT_TBP'
        ? { NOT: { tbpEnrollment: { equals: 'Yes', mode: 'insensitive' as const } } }
        : {}),
      ...(query.search
        ? {
            OR: [
              { leaseName: { contains: query.search, mode: 'insensitive' as const } },
              { addressLine1: { contains: query.search, mode: 'insensitive' as const } },
              { city: { contains: query.search, mode: 'insensitive' as const } },
              { postalCode: { contains: query.search, mode: 'insensitive' as const } },
              { zone: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.propertywareTenant.findMany({
        where,
        orderBy: { leaseName: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          building: { select: { id: true, name: true, addressLine1: true } },
        },
      }),
      this.prisma.propertywareTenant.count({ where }),
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
      /**
       * Occupancy, which is not the same question as `active`.
       *
       * `sourceStatus` carries Propertyware's own word — `Occupied` or
       * `Vacant` — and is independent of `isActive`, which says whether the
       * property is under management at all. Matched case-insensitively
       * because it is free text from another system rather than an enum we
       * control, and equality on an exact casing is the kind of filter that
       * silently returns nothing the day somebody writes "occupied".
       */
      ...(query.occupancy
        ? { sourceStatus: { equals: query.occupancy, mode: 'insensitive' as const } }
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
          // Which system the row came from, so the console can label a demo
          // property as one. Everything on this page is a real house somebody
          // lives in apart from these, and the difference has to be visible
          // rather than inferred from a name somebody could rename.
          sourceSystem: true,
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

  /**
   * Creates one demo property for this organization.
   *
   * The only write path into `propertyware_buildings` outside the Propertyware
   * sync, and it exists so the office can demonstrate the app — the console and
   * the phone, end to end — without booking a visit at a real tenant's home and
   * leaving the evidence in the portfolio afterwards. `demo-property.ts` carries
   * the reasoning and the fixture; the isolation is `sourceSystem`, which no
   * sync query matches.
   *
   * Written outside a transaction on purpose: there is one row to write, and
   * the audit entry that follows is a record of something that already happened
   * — rolling the property back because the log failed would leave the office
   * with neither. The audit write is awaited rather than fired and forgotten, so
   * a failure to record who did this surfaces as a failed request instead of
   * silently leaving an unattributed property in the portfolio.
   */
  async createDemoProperty(user: AuthenticatedUser) {
    /**
     * Every demo property this organization holds, active or not — the unique
     * key on `externalId` ignores `isActive`, so a deactivated one still owns
     * its number.
     *
     * Read as rows rather than a count because the next number comes from the
     * highest one used, not from how many there are; `nextDemoSequence` carries
     * why. At ten rows maximum this is a trivially small read.
     */
    const existing = await this.prisma.propertywareBuilding.findMany({
      where: { organizationId: user.organizationId, sourceSystem: DEMO_SOURCE_SYSTEM },
      select: { externalId: true },
    });
    if (existing.length >= DEMO_PROPERTY_LIMIT)
      throw new ApplicationError(
        409,
        'DEMO_PROPERTY_LIMIT_REACHED',
        `This organization already holds ${DEMO_PROPERTY_LIMIT} demo properties. Delete one before adding another.`,
      );

    const fixture = demoPropertyFixture(
      nextDemoSequence(existing.map((property) => property.externalId)),
    );
    const created = await this.prisma.propertywareBuilding
      .create({
        data: { organizationId: user.organizationId, ...fixture },
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
          sourceSystem: true,
          isActive: true,
          lastSyncedAt: true,
          updatedAt: true,
          totalArea: true,
          areaUnits: true,
          category: true,
          manualTotalArea: true,
          manualAreaUnit: true,
          portfolio: { select: { id: true, name: true, externalId: true } },
          _count: { select: { units: true, inspections: true } },
        },
      })
      .catch((error: unknown) => {
        /**
         * Two clicks on the button, or two coordinators at once. Both requests
         * read the same count and compose the same `externalId`, and the unique
         * key on `(organizationId, sourceSystem, externalId)` rejects the
         * second — which is the behaviour we want, because the alternative is
         * two identical demo properties. Reported as a conflict rather than a
         * 500, so the console can say something true about it.
         */
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          throw new ApplicationError(
            409,
            'DEMO_PROPERTY_EXISTS',
            'That demo property already exists. Refresh the list to see it.',
          );
        throw error;
      });

    await this.audit(
      this.prisma,
      user,
      'demo_property.created',
      created.id,
      { name: created.name, externalId: created.externalId, sourceSystem: created.sourceSystem },
      'PropertywareBuilding',
    );

    /**
     * The properties list is cached per organization, and the search results
     * under a second namespace, so both have to be bumped or the new property
     * is invisible until the entry expires. `dashboard` carries the property
     * count on the landing page and would disagree with the list beside it.
     */
    await Promise.all([
      this.cacheInvalidation?.bump('properties', user.organizationId),
      this.cacheInvalidation?.bump('propertySearch', user.organizationId),
      this.cacheInvalidation?.bump('dashboard', user.organizationId),
    ]);

    /**
     * The same shape a list row has, so nothing downstream needs a second case
     * for a property that arrived this way — the console names it in a toast and
     * refetches, but a script or a later caller reading `totalArea` off it gets
     * the field where it expects it. A new demo property has no units and no
     * leases, and `leaseSummary` of nothing is the honest answer to that rather
     * than an absent field.
     */
    return {
      ...created,
      totalArea: this.buildingTotalArea(created),
      leaseSummary: this.leaseSummary([], []),
    };
  }

  /**
   * Removes one demo property, and the demonstration it holds.
   *
   * ── WHAT IT WILL AND WILL NOT TOUCH ──────────────────────────────────────
   *
   * `sourceSystem: DEMO_SOURCE_SYSTEM` is in the lookup, not checked after it.
   * A Propertyware property is therefore not "refused" by this endpoint — it is
   * *not found* by it, which is the difference between a rule somebody could
   * argue with and a row this code cannot reach. There is no flag, body field or
   * query parameter that widens it.
   *
   * ── THE INSPECTIONS ──────────────────────────────────────────────────────
   *
   * A demo property that has been demonstrated at has an inspection, and the
   * foreign key from `Inspection` is `Restrict` — so deleting the building means
   * deleting the inspection, which means deleting recordings out of Cloudflare
   * Stream. That is exactly what `inspections:delete` gates, and it stays
   * gating it: holding `properties:manage` alone gets a refusal naming the
   * count, never a quiet cascade. Otherwise this endpoint would be a way around
   * a permission the office deliberately grants to almost nobody.
   *
   * The erasing itself is `eraseInspection`, unchanged and unwrapped. Its delete
   * order spans a dozen tables, is not derivable from `schema.prisma`, and broke
   * in production twice; a second implementation of it here would be the worst
   * thing this feature could add. Each runs in its own transaction, sequentially,
   * for the reason `deleteInspections` documents — one outer transaction over
   * several inspections' media is the shape the remote pooler drops at five
   * seconds.
   *
   * ── THE `Property` SHADOW ────────────────────────────────────────────────
   *
   * `ensureStandardLayout` upserts a `Property` row carrying *the same id* as the
   * building, because `PropertyArea.propertyId` keys to `Property` rather than to
   * `PropertywareBuilding`. Nothing relates the two tables, so deleting the
   * building alone would leave that row and its fifteen areas behind — and
   * `Property` has its own geocoding pass, so the orphan would go on being
   * looked up nightly for an address nobody manages. It goes too.
   */
  async deleteDemoProperty(user: AuthenticatedUser, id: string) {
    const property = await this.prisma.propertywareBuilding.findFirst({
      where: { id, organizationId: user.organizationId, sourceSystem: DEMO_SOURCE_SYSTEM },
      select: { id: true, name: true, externalId: true },
    });
    /**
     * 404 rather than 403, and the same 404 for "no such property" as for "that
     * is a real one". A reader who cannot delete it has no business learning
     * which of the two it was, and the message is the same either way.
     */
    if (!property)
      throw new ApplicationError(
        404,
        'DEMO_PROPERTY_NOT_FOUND',
        'No demo property with that id. Only demo properties can be deleted here.',
      );

    const inspections = await this.prisma.inspection.findMany({
      where: { organizationId: user.organizationId, propertywareBuildingId: id },
      select: { id: true },
    });
    if (inspections.length && !user.permissions.includes('inspections:delete'))
      throw new ApplicationError(
        409,
        'DEMO_PROPERTY_HAS_INSPECTIONS',
        `${property.name} still has ${inspections.length} ${
          inspections.length === 1 ? 'inspection' : 'inspections'
        }. Deleting it would delete ${
          inspections.length === 1 ? 'that inspection' : 'those inspections'
        } and ${
          inspections.length === 1 ? 'its' : 'their'
        } recordings, which needs the inspections:delete permission.`,
      );

    let orphanedStorageObjects = 0;
    for (const inspection of inspections) {
      const result = await this.eraseInspection(user, inspection.id);
      orphanedStorageObjects += result.orphanedStorageObjects;
    }

    await this.eraseDemoPropertyRecord(user.organizationId, id);

    await this.audit(
      this.prisma,
      user,
      'demo_property.deleted',
      id,
      {
        name: property.name,
        externalId: property.externalId,
        sourceSystem: DEMO_SOURCE_SYSTEM,
        inspectionsErased: inspections.length,
      },
      'PropertywareBuilding',
    );

    await Promise.all([
      this.cacheInvalidation?.bump('properties', user.organizationId),
      this.cacheInvalidation?.bump('propertySearch', user.organizationId),
      this.cacheInvalidation?.bump('propertyDetails', user.organizationId),
      this.cacheInvalidation?.bump('dashboard', user.organizationId),
    ]);
    // The inspections list every open console is showing lost rows too.
    if (inspections.length)
      await this.cacheInvalidation?.publish({
        type: 'inspection.changed',
        organizationId: user.organizationId,
      });

    return {
      deleted: true,
      id,
      name: property.name,
      inspectionsErased: inspections.length,
      orphanedStorageObjects,
    };
  }

  /**
   * The building row, its `Property` shadow, and everything keyed to either.
   *
   * One transaction, so a foreign key nobody anticipated rolls the whole thing
   * back rather than leaving a half-deleted property — a building gone with its
   * areas still present, or the reverse, is worse than not having deleted it.
   *
   * The order is dictated by the schema and nothing else; every step below is a
   * `Restrict` that would otherwise refuse. `AreaChecklistItem` and
   * `PropertyAreaAlias` are absent because they cascade from `PropertyArea`, and
   * `PropertyGeofence` and `PropertywareInspectionDocument` because they cascade
   * from the building. `PropertywareTenant` and `TbpQuarterPlanStop` are absent
   * because they are `SetNull` — a tenancy outlives the property it pointed at,
   * which is correct here: a demo property should never have had one.
   *
   * Units, leases and Jobber links are deleted although the fixture creates
   * none. They are what a demo property would accumulate if somebody ever links
   * one or the fixture grows, and a `deleteMany` that matches nothing costs a
   * statement.
   */
  private async eraseDemoPropertyRecord(organizationId: string, id: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        // The baseline chain, deepest first. A demo move-in leaves one of these.
        await tx.baselineMedia.deleteMany({
          where: { baselineAreaCondition: { baselineInspection: { propertyId: id } } },
        });
        await tx.baselineAreaCondition.deleteMany({
          where: { baselineInspection: { propertyId: id } },
        });
        await tx.baselineInspection.deleteMany({ where: { propertyId: id } });

        // Floor plans before the areas that cite them as their source.
        await tx.floorPlanExtractionJob.deleteMany({
          where: { floorPlan: { propertyId: id } },
        });
        await tx.propertyFloorPlan.deleteMany({ where: { propertyId: id } });

        // Areas before floors and units: `PropertyArea.floorId` and `.unitId`
        // both point outward and both restrict.
        await tx.propertyArea.deleteMany({ where: { propertyId: id } });
        await tx.propertyFloor.deleteMany({ where: { propertyId: id } });

        // Scoped by organization as well as id, because this one is keyed on a
        // plain uuid that happens to equal the building's rather than on a
        // relation the tenant policy already covers.
        await tx.property.deleteMany({ where: { id, organizationId } });

        await tx.propertywareLease.deleteMany({ where: { buildingId: id } });
        await tx.jobberPropertyLink.deleteMany({ where: { propertywareBuildingId: id } });
        await tx.propertywareUnit.deleteMany({ where: { buildingId: id } });
        await tx.propertywareBuilding.delete({ where: { id } });
      });
    } catch (error) {
      /**
       * A foreign key this order does not account for.
       *
       * Reported as a refusal naming nothing deleted, rather than a 500: the
       * transaction has already rolled back, so the honest thing to say is that
       * the property is still there and why. `P2003` is the foreign-key
       * violation; `P2014` is Prisma's own required-relation guard.
       */
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2003' || error.code === 'P2014')
      )
        throw new ApplicationError(
          409,
          'DEMO_PROPERTY_STILL_REFERENCED',
          'Something still references this demo property, so nothing was deleted. Remove it and try again.',
        );
      throw error;
    }
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
        // Read here as well as in the list, so the badge does not disappear the
        // moment somebody clicks through from one to the other.
        sourceSystem: true,
        isActive: true,
        lastSyncedAt: true,
        updatedAt: true,
        totalArea: true,
        areaUnits: true,
        category: true,
        manualTotalArea: true,
        manualAreaUnit: true,
        // Everything else Propertyware holds on the building, for the page's
        // Details tab. Split below: the access codes and owner phones never
        // leave this method, so they are never in the cached response.
        details: true,
        ownerDetails: true,
        // How close counts as being at this property. Read here so the page
        // that sets it does not need a second request to know the current one.
        geofence: {
          select: { enterRadiusMeters: true, exitRadiusMeters: true, latitude: true, longitude: true },
        },
        // The office's switches: management ended, benefit package opted out
        // (2026-10-08). Their page has its own request; this is for the badges.
        serviceStatus: { select: SERVICE_STATUS_VIEW_SELECT },
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
    const {
      totalArea,
      areaUnits,
      category,
      manualTotalArea,
      manualAreaUnit,
      updatedAt,
      geofence,
      details,
      ownerDetails,
      serviceStatus,
      ...rest
    } = property;
    // The relevant lease for a unit is its active lease; a unit with none reads
    // "No relevant lease" (null) rather than an invented status.
    const relevantLease = new Map(property.leases.map((lease) => [lease.unitId, lease]));
    return {
      ...rest,
      category,
      details: detailsView(details),
      owner: ownerView(ownerDetails),
      serviceStatus: serviceStatusView(serviceStatus),
      /**
       * Always answered, never null.
       *
       * A property with no row of its own is on the defaults, which is a real
       * answer rather than an absence -- and a page that had to know about the
       * defaults to render "40 m" would be a second place for them to live.
       * `set` is what separates "nobody has decided" from "somebody chose 40".
       */
      geofence: {
        enterRadiusMeters: geofence?.enterRadiusMeters ?? SEGMENT_DEFAULTS.enterRadiusMeters,
        exitRadiusMeters: geofence?.exitRadiusMeters ?? SEGMENT_DEFAULTS.exitRadiusMeters,
        centreMoved: Boolean(geofence?.latitude && geofence?.longitude),
        set: Boolean(geofence),
      },
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

  /**
   * The property's access codes and its owners' phones, for someone who
   * manages properties.
   *
   * Its own request, read fresh and never cached: the lockbox, gate and alarm
   * codes open a tenant's home, so they reach a browser only when somebody with
   * the right to see them asks. The page asks when "Show" is pressed.
   */
  async propertyPrivateDetails(user: AuthenticatedUser, id: string) {
    const property = await this.prisma.propertywareBuilding.findFirst({
      where: { id, organizationId: user.organizationId },
      select: { details: true, ownerDetails: true },
    });
    if (!property) throw new ApplicationError(404, 'PROPERTY_NOT_FOUND', 'Property was not found.');
    return privateDetails(property.details, property.ownerDetails);
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
    const quarterAsked = quarterFilter(query.quarter);
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
      /**
       * "Unassigned" on the list and the map means still waiting for somebody:
       * a visit to come, nobody on it -- the dashboard's count, and its "Assign
       * now" link. A cancelled or done visit needs nobody, and the list's
       * "Unassigned only" used to show them too (2026-10-07).
       */
      ...(query.unassignedOnly === 'true' ? [{ status: { in: UPCOMING_INSPECTION_STATUSES } }] : []),
      // The quarter asked for, decided the same way `visitQuarter` decides the
      // tag on each row: by the plan first, then the programme title, and only
      // then by the day. A plan that starts fifteen days early puts its first
      // visits in the quarter before, and a day range alone would file them
      // under it -- which is the whole bug.
      //
      // The one case the two can differ is a programme-titled visit with no
      // plan whose title names no quarter: tagged by its day here, matched by
      // nothing. Postgres could answer it with a regex, Prisma's filters
      // cannot, and there are none -- all 362 name their quarter.
      ...(quarterAsked
        ? [
            {
              OR: [
                { tbpPlanStop: { plan: { quarterYear: quarterAsked.year, quarterNumber: quarterAsked.quarter } } },
                {
                  AND: [
                    { tbpPlanStop: { is: null } },
                    { jobberVisitTitle: { contains: TBP_TITLE_MARKER, mode: 'insensitive' as const } },
                    { jobberVisitTitle: { contains: quarterAsked.label, mode: 'insensitive' as const } },
                  ],
                },
                {
                  AND: [
                    { tbpPlanStop: { is: null } },
                    { NOT: { jobberVisitTitle: { contains: TBP_TITLE_MARKER, mode: 'insensitive' as const } } },
                    { scheduledAt: { gte: quarterAsked.from, lte: quarterAsked.to } },
                  ],
                },
              ],
            },
          ]
        : []),
      // A benefit-package visit is one a quarter's plan created, or one booked
      // in Jobber under the programme's name -- the quarters this system did
      // not plan exist only as the second.
      ...(query.tbpOnly === 'true'
        ? [
            {
              OR: [
                { tbpPlanStop: { isNot: null } },
                { jobberVisitTitle: { contains: TBP_TITLE_MARKER, mode: 'insensitive' as const } },
              ],
            },
          ]
        : []),
    ];
    /**
     * Every narrowing as one more AND, so no two can overwrite each other:
     * the visit state "Done" and the search are each an `OR` of their own.
     */
    const narrowing: Prisma.InspectionWhereInput[] = [
      ...assignmentFilters,
      ...(query.status ? [inspectionStatusWhere(query.status)] : []),
      // The day itself: `scheduledAt` is a date, held as its UTC midnight.
      ...(query.scheduledOn ? [{ scheduledAt: new Date(`${query.scheduledOn}T00:00:00.000Z`) }] : []),
      ...(query.scheduledFrom || query.scheduledTo
        ? [
            {
              scheduledAt: {
                gte: query.scheduledFrom ? new Date(query.scheduledFrom) : undefined,
                lte: query.scheduledTo ? new Date(query.scheduledTo) : undefined,
              },
            },
          ]
        : []),
      ...inspectionSearchWhere(query.search),
    ];
    /** Every filter except the type: what the type tabs count across. */
    const whereEveryType: Prisma.InspectionWhereInput = {
      organizationId: user.organizationId,
      ...(query.propertyId ? { propertywareBuildingId: query.propertyId } : {}),
      ...(query.portfolioId ? { propertywareBuilding: { portfolioId: query.portfolioId } } : {}),
      ...(narrowing.length ? { AND: narrowing } : {}),
    };
    const where: Prisma.InspectionWhereInput = {
      ...whereEveryType,
      ...(query.inspectionType ? { inspectionType: query.inspectionType } : {}),
    };
    const select = {
      id: true,
      status: true,
      // With the status, where the visit stands in the office's words: a done
      // visit whose reason says the technician could not get in reads as that.
      completionBlockedReason: true,
      inspectionType: true,
      baselineInspectionId: true,
      baselineInspection: {
        select: { id: true, inspectionType: true, scheduledAt: true, completedAt: true },
      },
      priority: true,
      scheduledAt: true,
      // What says which quarter of the programme a visit belongs to.
      jobberVisitTitle: true,
      tbpPlanStop: { select: { plan: { select: { quarterYear: true, quarterNumber: true } } } },
      createdAt: true,
      updatedAt: true,
      internalNotes: true,
      nextInspectionAlert: true,
      maintenanceComments: true,
      generalComments: true,
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
      /**
       * Enough to say whether anything has been recorded here.
       *
       * Areas alone would overstate it: an inspection is created with its
       * property's approved layout snapshotted onto it, so a record that has
       * never been walked can still carry an area — two of the recovered
       * move-ins have exactly one, the HVAC system, and nothing else. Findings
       * and areas together still cannot distinguish a snapshot from a
       * walkthrough, which is why the photograph count is fetched separately
       * below.
       */
      _count: { select: { areas: true, findings: true } },
    } satisfies Prisma.InspectionSelect;
    const [items, total, byType] = await Promise.all([
      this.prisma.inspection.findMany({
        relationLoadStrategy: 'join',
        where,
        select,
        // `id` breaks the ties, and is not decoration: twenty of these share a
        // single day -- the whole of a planned day is one date -- and a page
        // boundary inside such a run is otherwise ordered by nothing at all,
        // so a row can appear on both page 2 and page 3, or on neither.
        orderBy: [{ scheduledAt: query.scheduledOrder === 'asc' ? 'asc' : 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.inspection.count({ where }),
      query.withTypeCounts === 'true'
        ? this.prisma.inspection.groupBy({
            by: ['inspectionType'],
            where: whereEveryType,
            _count: { _all: true },
          })
        : Promise.resolve(null),
    ]);
    const typeCounts = byType
      ? Object.fromEntries(byType.map((group) => [group.inspectionType, group._count._all]))
      : undefined;

    /**
     * How many photographs each row actually holds.
     *
     * `InspectionPhoto` has no reverse relation on `Inspection`, so this cannot
     * be a `_count` in the select above — but it is the only honest answer to
     * "has this been walked". An inspection is created with its property's
     * approved layout snapshotted onto it, so an area count says a plan
     * existed, not that anybody photographed anything.
     *
     * One grouped query over the page's own ids, so it costs the same whether
     * the rows have one photograph or four hundred.
     */
    const photoCounts = await this.prisma.inspectionPhoto.groupBy({
      by: ['inspectionId'],
      where: { inspectionId: { in: items.map((item) => item.id) } },
      _count: { _all: true },
    });
    const photosByInspection = new Map(
      photoCounts.map((row) => [row.inspectionId, row._count._all]),
    );

    /**
     * Whether the tenancy at each property is in the benefit package.
     *
     * Read from the office's tenancy report, which is the only source that
     * knows about enrolment — the REST lease endpoint does not expose it.
     * Joined on the building, because that is the only key the tenant sync
     * writes; there is no unit on a tenancy row.
     *
     * `Not Verified` is carried through as its own answer rather than folded
     * into "no". Seventeen active tenancies have it, and it means nobody has
     * checked — which is neither yes nor no, and collapsing it would invent a
     * fact the office deliberately did not give.
     */
    // The scalar id is not in the select — only the relation — so it is read
    // from there rather than added, which would widen every other consumer.
    const buildingIds = items
      .map((item) => item.propertywareBuilding?.id)
      .filter((id): id is string => Boolean(id));
    const tenancies = buildingIds.length
      ? await this.prisma.propertywareTenant.findMany({
          where: { organizationId: user.organizationId, isActive: true, propertywareBuildingId: { in: buildingIds } },
          select: { propertywareBuildingId: true, tbpEnrollment: true },
        })
      : [];
    const enrolmentByBuilding = new Map<string, Set<string>>();
    for (const tenancy of tenancies) {
      if (!tenancy.propertywareBuildingId) continue;
      const held = enrolmentByBuilding.get(tenancy.propertywareBuildingId) ?? new Set<string>();
      held.add(tbpState(tenancy.tbpEnrollment));
      enrolmentByBuilding.set(tenancy.propertywareBuildingId, held);
    }

    /**
     * Move-outs on this page with nothing to compare against.
     *
     * Uses `baselineWhere` — the comparison's own predicate — rather than a
     * cheaper approximation. Building and date alone reported 14 of 17 where
     * the real rule finds 15, so one move-out would have been told it had a
     * baseline that `generate` then refuses with MOVE_IN_BASELINE_NOT_FOUND.
     * A warning that disagrees with the thing it warns about is worse than
     * none.
     *
     * One query per move-out. A page holds twenty and most are not move-outs;
     * the alternative is restating the scope here, which is the drift this
     * avoids.
     */
    const missingBaseline = new Set<string>();
    for (const item of items) {
      if (item.inspectionType !== InspectionType.MOVE_OUT) continue;
      const baseline = await this.prisma.inspection.findFirst({
        where: baselineWhere({
          organizationId: user.organizationId,
          propertywareBuildingId: item.propertywareBuilding?.id ?? null,
          propertywareUnitId: item.propertywareUnit?.id ?? null,
          propertywareLeaseId: item.propertywareLease?.id ?? null,
          scheduledAt: item.scheduledAt,
        }),
        select: { id: true },
      });
      if (!baseline) missingBaseline.add(item.id);
    }

    const listed = this.page(
      items.map((item) => ({
        ...item,
        /** The quarter of the programme it belongs to, not the one its day falls in. */
        quarter: visitQuarter(item),
        /**
         * Only ever set on a move-out. On any other type the question is not
         * "missing", it is meaningless — and a false would read as an
         * assurance that something had been checked.
         */
        baselineMissing:
          item.inspectionType === InspectionType.MOVE_OUT ? missingBaseline.has(item.id) : undefined,
        evidence: {
          areas: item._count.areas,
          findings: item._count.findings,
          photos: photosByInspection.get(item.id) ?? 0,
        },
        /**
         * Null when the property has no active tenancy at all — vacant, or a
         * building the tenancy report does not cover. Deliberately not
         * "not enrolled": there is nobody to enrol.
         *
         * MIXED where a multi-unit building's tenancies disagree. One building
         * has three, and answering for it with whichever came back first
         * would be a coin toss presented as a fact.
         */
        tbp: item.propertywareBuilding?.id
          ? (rollUpTbp(enrolmentByBuilding.get(item.propertywareBuilding.id)) ?? null)
          : null,
      })),
      total,
      query,
    );
    return typeCounts ? { ...listed, typeCounts } : listed;
  }

  async inspection(user: AuthenticatedUser, id: string) {
    const inspection = await this.prisma.inspection.findFirst({
      relationLoadStrategy: 'join',
      where: { id, organizationId: user.organizationId },
      select: {
        id: true,
        status: true,
        // Read only to answer whether the date is Jobber's; see the return.
        jobberVisitId: true,
        // The visit as the coordinator wrote it, for the office. This select
        // sits behind inspections:read; the public report builds its own.
        jobberVisitTitle: true,
        jobberVisitDetails: true,
        // What the technician reported about those services at submission.
        servicesReport: true,
        servicesReportedAt: true,
        // What this console asked Jobber for: the booking, and the edits since.
        jobberOutboundTasks: {
          where: { kind: { in: [JobberOutboundKind.VISIT_CREATE, ...VISIT_EDIT_KINDS] } },
          select: { kind: true, status: true, attempts: true, lastError: true, sentAt: true },
        },
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
        nextInspectionAlert: true,
        maintenanceComments: true,
        generalComments: true,
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

    /**
     * What has actually been recorded here, as opposed to planned.
     *
     * The same distinction the list makes. An inspection is created with its
     * property's approved layout snapshotted onto it, so an area count says a
     * plan exists — not that anybody walked the property.
     *
     * The console warns from this. An import replaces what it finds, so before
     * a file is chosen the page has to be able to say whether anything is
     * standing there to lose. It no longer decides *whether* to offer the
     * import: that was gated on emptiness, and gating on it refused the case
     * an import is actually for — a record here that is wrong.
     */
    const [areas, findings, photos, media, responses] = await Promise.all([
      this.prisma.inspectionArea.count({ where: { inspectionId: inspection.id } }),
      this.prisma.inspectionFinding.count({ where: { inspectionId: inspection.id } }),
      this.prisma.inspectionPhoto.count({ where: { inspectionId: inspection.id } }),
      this.prisma.inspectionMedia.count({ where: { inspectionId: inspection.id } }),
      this.prisma.inspectionAreaChecklistResponse.count({
        where: { inspectionArea: { inspectionId: inspection.id } },
      }),
    ]);
    // All five asked the same way, rather than two from the `_count` above and
    // three from here. They answer one question and are read as one object, and
    // splitting the source made each new counter a separate place to remember.
    const evidence = { areas, findings, photos, media, responses };

    /**
     * The move-in this move-out is compared against, and whether there is one.
     *
     * The same predicate the comparison uses, so the page cannot promise a
     * baseline that `generate` then refuses. Undefined on every other type —
     * the question is meaningless there, and a `false` would read as an
     * assurance that something had been checked.
     *
     * Named on the page instead of `baselineInspection`, the link written at
     * creation: the comparison and the AI both read this one, and the page said
     * "No move-in baseline is linked" over a move-out whose comparison was
     * reading a move-in all along.
     */
    const comparisonBaseline =
      inspection.inspectionType === InspectionType.MOVE_OUT
        ? await this.prisma.inspection.findFirst({
            where: baselineWhere({
              organizationId: user.organizationId,
              propertywareBuildingId: inspection.propertywareBuilding?.id ?? null,
              propertywareUnitId: inspection.propertywareUnit?.id ?? null,
              propertywareLeaseId: inspection.propertywareLease?.id ?? null,
              scheduledAt: inspection.scheduledAt,
            }),
            // The latest, as `ComparisonService.resolveBaseline` picks it.
            orderBy: { scheduledAt: 'desc' },
            select: { id: true, scheduledAt: true },
          })
        : undefined;
    const baselineMissing =
      comparisonBaseline === undefined ? undefined : comparisonBaseline === null;

    // Whether the date is Jobber's to change, rather than Jobber's identifier:
    // the edit form needs the answer, and the visit id is nothing it can use.
    const { jobberVisitId, jobberOutboundTasks, ...detail } = inspection;
    // Optional-chained for the test doubles that stand in for this read without it.
    const consoleTasks = jobberOutboundTasks ?? [];
    // The inspection itself, read from its evidence rather than from a button
    // nobody presses: see inspection-timing.ts.
    const span = inspectionSpan(await inspectionEvidenceTimes(this.prisma, user.organizationId, id));
    const booking = consoleTasks.find((task) => task.kind === JobberOutboundKind.VISIT_CREATE);
    return {
      ...detail,
      evidence,
      baselineMissing,
      comparisonBaseline,
      scheduledInJobber: Boolean(jobberVisitId),
      jobberBooking: booking ? { status: booking.status, attempts: booking.attempts, lastError: booking.lastError, sentAt: booking.sentAt } : null,
      // Edits waiting for, or refused by, Jobber. A sent one is history.
      jobberPushes: consoleTasks
        .filter((task) => task.kind !== JobberOutboundKind.VISIT_CREATE && task.status !== JobberOutboundStatus.SENT)
        .map((task) => ({ kind: task.kind, status: task.status, attempts: task.attempts, lastError: task.lastError })),
      // Whether a change made here reaches Jobber, so the edit form can say so.
      jobberEditsPushed: getJobberConfig().pushEditsEnabled,
      inspectionWorked: span
        ? { from: span.from.toISOString(), to: span.to.toISOString(), clock: span.clock }
        : null,
    };
  }

  /**
   * The inspection's activity: what happened, to what, and who did it.
   *
   * It used to answer only the action and the time, so the console could say
   * "Finding approved, 2:14 PM" but never by whom -- for the decisions the audit
   * log exists to account for. And finding decisions, recorded against the
   * finding rather than the inspection, never appeared at all. They are read
   * here by the inspection id their metadata carries.
   *
   * Metadata itself is still not exposed: it can hold a rejection reason or a
   * TBD note. `detail` names only the thing acted on -- the area for an area's
   * review mark, the finding's title for a decision -- and is null otherwise.
   */
  async inspectionAudit(user: AuthenticatedUser, id: string, query: AuditListQueryDto) {
    const where = {
      organizationId: user.organizationId,
      OR: [
        { entityType: 'Inspection', entityId: id },
        { entityType: 'InspectionFinding', metadata: { path: ['inspectionId'], equals: id } },
      ],
    } satisfies Prisma.AuditLogWhereInput;
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          action: true,
          createdAt: true,
          entityType: true,
          entityId: true,
          actorUserId: true,
          actorApiClientId: true,
          metadata: true,
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    const actorIds = [...new Set(rows.flatMap((row) => (row.actorUserId ? [row.actorUserId] : [])))];
    const findingIds = [
      ...new Set(rows.flatMap((row) => (row.entityType === 'InspectionFinding' ? [row.entityId] : []))),
    ];
    const [actors, findings] = await Promise.all([
      actorIds.length
        ? this.prisma.userProfile.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, displayName: true },
          })
        : [],
      findingIds.length
        ? this.prisma.inspectionFinding.findMany({
            where: { id: { in: findingIds }, inspectionId: id },
            select: { id: true, title: true },
          })
        : [],
    ]);
    const actorName = new Map(actors.map((actor) => [actor.id, actor.displayName]));
    const findingTitle = new Map(findings.map((finding) => [finding.id, finding.title]));

    const items = rows.map((row) => {
      const areaName =
        (row.action.startsWith('AREA_REVIEW') || row.action === 'AI_REANALYSIS_REQUESTED') &&
        row.metadata &&
        typeof row.metadata === 'object' &&
        !Array.isArray(row.metadata) &&
        typeof row.metadata.areaName === 'string'
          ? row.metadata.areaName
          : null;
      return {
        id: row.id,
        action: row.action,
        createdAt: row.createdAt,
        actorName: row.actorUserId
          ? (actorName.get(row.actorUserId) ?? null)
          : row.actorApiClientId
            ? 'API client'
            : null,
        detail:
          row.entityType === 'InspectionFinding'
            ? (findingTitle.get(row.entityId) ?? null)
            : areaName,
      };
    });
    return this.page(items, total, query);
  }

  async createInspection(user: AuthenticatedUser, input: CreateAdminInspectionDto) {
    const booking = input.jobberBooking ? this.bookableRequest(input) : null;
    // A booking writes its services into the Details it sends; without one they
    // are the whole of the Details.
    const unbookedServices = booking ? null : this.unbookedServicesDetails(input);
    const inspection = await this.prisma.$transaction(async (tx) => {
      // Every rule about what an inspection may be lives in inspection-creation.ts,
      // so a Jobber-scheduled visit is held to the same ones — including the area
      // snapshot the whole technician workflow reads. What stays here is what only
      // an administrator's request can answer: who to attribute the creation to,
      // and who to assign it to.
      const plan = await resolveInspectionPlan(tx, {
        organizationId: user.organizationId,
        buildingId: input.propertyId,
        unitId: input.unitId,
        leaseId: input.leaseId,
        inspectionType: input.inspectionType,
        scheduledAt: new Date(input.scheduledAt),
        areaIds: input.areaIds,
        allowTechnicianAreaCapture: input.allowTechnicianAreaCapture,
      });
      const inspection = await insertInspection(tx, plan, {
        priority: input.priority,
        internalNotes: input.internalNotes,
        createdById: user.id,
        ...(unbookedServices ? { jobberVisitDetails: unbookedServices.details } : {}),
      });
      await this.audit(tx, user, 'INSPECTION_CREATED', inspection.id, {
        priority: input.priority,
        inspectionType: input.inspectionType,
        baselineInspectionId: plan.baselineInspectionId,
        // Worth an audit entry: it is the decision to inspect a property whose
        // layout nobody has approved, and it explains an inspection that begins
        // with no areas at all.
        allowTechnicianAreaCapture: plan.technicianWillCapture,
        areasFromApprovedPlan: plan.approvedAreas.length,
        // What the inspection actually covers, which differs when scoped.
        areasInspected: plan.scopedAreas.length,
        ...(unbookedServices ? { services: unbookedServices.services } : {}),
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
      if (booking) await this.queueJobberBooking(tx, user, inspection.id, plan, booking);
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

  /**
   * Whether this request may book its visit in Jobber, asked before anything is written.
   */
  private bookableRequest(input: CreateAdminInspectionDto): JobberBookingInput {
    // Occupied, move-in, move-out, back-to-market and HVAC: the visits the
    // office books in Jobber. A lockbox, a roof or a filter delivery has no
    // Details format here to write.
    if (!isBookableInspectionType(input.inspectionType))
      throw new ApplicationError(
        422,
        'JOBBER_BOOKING_TYPE_UNSUPPORTED',
        'This kind of inspection cannot be booked in Jobber from here.',
      );
    if (!getJobberConfig().bookingEnabled)
      throw new ApplicationError(
        409,
        'JOBBER_BOOKING_DISABLED',
        'Booking visits in Jobber is switched off on this server. Book the visit in Jobber instead.',
      );
    const booking = input.jobberBooking as JobberBookingInput;
    const problems = jobberBookingProblems(booking);
    if (problems.length) throw new ApplicationError(422, 'JOBBER_BOOKING_INVALID', problems.join(' '));
    return booking;
  }

  /**
   * The services a visit not booked in Jobber from here books, as its Details.
   *
   * The services line alone -- "Pest Control + HVAC Inspection" -- because that
   * is what the phone lists the job's services from, and what the console asks
   * the coordinator to put in the visit's Details in Jobber. Null when nothing
   * is booked, so an inspection created without services is created exactly as
   * before. Checked before anything is written, like a booking.
   */
  private unbookedServicesDetails(
    input: CreateAdminInspectionDto,
  ): { details: string; services: string[] } | null {
    const requested = input.visitServices as VisitServicesBooking | undefined;
    if (!requested || !booksAnyService(requested.services)) return null;
    // The kinds whose Details this system writes: a lockbox, a roof or a filter
    // delivery has no services line to add them to.
    if (!isBookableInspectionType(input.inspectionType))
      throw new ApplicationError(
        422,
        'VISIT_SERVICES_TYPE_UNSUPPORTED',
        'Services can be added to an occupied, move-in, move-out, back-to-market or HVAC inspection only.',
      );
    const problems = visitServicesProblems(requested);
    if (problems.length) throw new ApplicationError(422, 'VISIT_SERVICES_INVALID', problems.join(' '));
    return {
      details: visitServicesDetails(input.inspectionType, requested)!,
      services: bookedServiceNames(requested.services),
    };
  }

  /**
   * Queues the Jobber booking inside the transaction that creates the inspection.
   *
   * "This inspection exists" and "Jobber will be asked to book it" commit
   * together or not at all, the outbox rule the completion push already follows.
   * Refused -- so nothing is created -- when there is nothing to book against: no
   * connected account, or a property Jobber does not know. The console asks
   * both before offering the booking, so this is the backstop, not the message.
   *
   * The title and Details are written onto the inspection now: the technician
   * reads them on the phone whether or not Jobber has answered yet, and the
   * worker sends exactly this text.
   */
  private async queueJobberBooking(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    inspectionId: string,
    plan: InspectionPlan,
    booking: JobberBookingInput,
  ) {
    const connection = await tx.jobberConnection.findUnique({
      where: { organizationId: user.organizationId },
      select: { status: true },
    });
    if (connection?.status !== JobberConnectionStatus.CONNECTED)
      throw new ApplicationError(
        409,
        'JOBBER_NOT_CONNECTED',
        'Jobber is not connected, so the visit cannot be booked there.',
      );
    const link = await linkedJobberProperty(tx, user.organizationId, {
      buildingId: plan.property.id,
      unitId: plan.unit?.id ?? null,
    });
    if (link.status !== 'LINKED')
      throw link.status === 'AMBIGUOUS'
        ? new ApplicationError(
            422,
            'JOBBER_PROPERTY_AMBIGUOUS',
            'This property is linked to more than one Jobber property. Fix the link on the Jobber page first.',
          )
        : new ApplicationError(
            422,
            'JOBBER_PROPERTY_NOT_LINKED',
            'This property is not linked to a Jobber property yet. Link it on the Jobber page first.',
          );

    const inspectionType = isBookableInspectionType(plan.inspectionType) ? plan.inspectionType : 'OCCUPIED';
    const text = jobberBookingText(booking, {
      inspectionType,
      address: bookingAddress(plan.property, plan.unit),
      scheduledOn: plan.scheduledAt.toISOString().slice(0, 10),
      inspectionUrl: `${webOrigin()}/inspections/${inspectionId}`,
    });
    await tx.inspection.update({
      where: { id: inspectionId },
      data: { jobberVisitTitle: text.visitTitle, jobberVisitDetails: text.visitDetails },
    });
    await tx.jobberOutboundTask.create({
      data: {
        organizationId: user.organizationId,
        inspectionId,
        kind: JobberOutboundKind.VISIT_CREATE,
        status: JobberOutboundStatus.PENDING,
        jobTitle: text.jobTitle,
        createdById: user.id,
      },
    });
    // Which property and which services: never the Details, which carry the
    // tenant's phone and a way in.
    await this.audit(tx, user, 'JOBBER_VISIT_BOOKING_QUEUED', inspectionId, {
      jobberPropertyId: link.jobberPropertyId,
      inspectionType,
      benefitPackage: inspectionType === 'OCCUPIED' && booking.benefitPackage,
      // Every kind of visit can book them now, and writes them when it does.
      services: bookedServiceNames(booking.services),
    });
  }

  /**
   * What the console needs to offer a Jobber booking, before the inspection exists.
   *
   * Whether booking is on and Jobber connected, which Jobber property the visit
   * would go to, and a start for the form read off the tenant report and the
   * lease. Behind inspections:manage, like creating the inspection: it carries
   * tenant names.
   */
  async jobberBookingContext(
    user: AuthenticatedUser,
    query: JobberBookingContextQueryDto,
  ): Promise<JobberBookingContext> {
    const organizationId = user.organizationId;
    const building = await requireBuilding(this.prisma, organizationId, query.propertyId, true);
    const unit = query.unitId
      ? await this.prisma.propertywareUnit.findFirst({
          where: { id: query.unitId, organizationId, buildingId: building.id, isActive: true },
          select: { id: true, addressLine1: true },
        })
      : null;
    const [connection, link, start, technician] = await Promise.all([
      this.prisma.jobberConnection.findUnique({ where: { organizationId }, select: { status: true } }),
      linkedJobberProperty(this.prisma, organizationId, { buildingId: building.id, unitId: unit?.id ?? null }),
      this.bookingTenancy(organizationId, building.id, unit?.id ?? null, query.leaseId ?? null),
      query.technicianId
        ? this.prisma.userProfile.findFirst({
            where: {
              id: query.technicianId,
              memberships: { some: { organizationId, role: UserRole.INSPECTION_TECHNICIAN } },
            },
            select: { email: true },
          })
        : null,
    ]);
    return {
      enabled: getJobberConfig().bookingEnabled,
      connected: connection?.status === JobberConnectionStatus.CONNECTED,
      jobberProperty:
        link.status === 'LINKED' ? { status: 'LINKED', address: link.address } : { status: link.status, address: null },
      address: bookingAddress(building, unit),
      prefill:
        start.tenancy || start.tenantNames.length
          ? bookingFromTenancy({
              zone: start.tenancy?.zone ?? null,
              managementPlan: start.tenancy?.managementPlan ?? null,
              hvacPlan: start.tenancy?.hvacPlan ?? null,
              hvacFilterLocation: start.tenancy?.hvacFilterLocation ?? null,
              hvacFilterSizes: start.tenancy?.hvacFilterSizes ?? [],
              tbpEnrollment: start.tenancy?.tbpEnrollment ?? null,
              tenantNames: start.tenantNames,
            })
          : null,
      technicianInJobber: technician
        ? Boolean(await jobberUserIdForEmail(this.prisma, organizationId, technician.email))
        : null,
    };
  }

  /**
   * The tenancy and lease a booking's prefill is read from.
   *
   * `tenancyOnFile` is shared with the handset's job screen, which shows the
   * same file to the technician standing at the door. The matching rules, and
   * why they refuse to guess, are documented there.
   */
  private bookingTenancy(
    organizationId: string,
    buildingId: string,
    unitId: string | null,
    leaseId: string | null,
  ) {
    return tenancyOnFile(this.prisma, { organizationId, buildingId, unitId, leaseId });
  }

  /**
   * Queues a console edit for the inspection's Jobber visit, when edits are pushed.
   *
   * In the caller's transaction. Nothing happens for an inspection with no
   * Jobber visit, or while pushing edits is switched off -- then Jobber keeps
   * its copy, as it always did.
   */
  private pushVisitEdit(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    inspectionId: string,
    kind: VisitEditKind,
  ) {
    if (!getJobberConfig().pushEditsEnabled) return null;
    return requestVisitPush(tx, {
      organizationId: user.organizationId,
      inspectionId,
      kind,
      requestedById: user.id,
    });
  }

  /**
   * Edits the visit's title and Details from the console.
   *
   * For a visit Jobber has, the change is pushed there and the sync holds off
   * until it has gone. For one booked here and not yet sent, the booking sends
   * the edited text. The text itself is never audited: it carries the tenant's
   * phone and a way in.
   */
  async updateJobberVisit(user: AuthenticatedUser, id: string, input: UpdateJobberVisitDto) {
    const existing = await this.requireInspection(user.organizationId, id);
    // A visit the technician has submitted is done: its Details are the record
    // of what they were told, and Jobber already has the visit complete.
    if (isDoneInspectionStatus(existing.status) || existing.status === InspectionStatus.CANCELLED)
      throw new ApplicationError(
        409,
        'INSPECTION_FINALIZED',
        'This visit has been done or cancelled, so it can no longer be changed.',
      );
    await this.prisma.$transaction(async (tx) => {
      const pendingBooking = await tx.jobberOutboundTask.findFirst({
        where: {
          organizationId: user.organizationId,
          inspectionId: id,
          kind: JobberOutboundKind.VISIT_CREATE,
          status: { in: [JobberOutboundStatus.PENDING, JobberOutboundStatus.FAILED] },
        },
        select: { id: true },
      });
      if (!existing.jobberVisitId && !pendingBooking)
        throw new ApplicationError(409, 'NO_JOBBER_VISIT', 'This inspection has no Jobber visit to edit.');
      if (existing.jobberVisitId && !getJobberConfig().pushEditsEnabled)
        throw new ApplicationError(
          409,
          'JOBBER_EDITS_OFF',
          'Changes made here are not sent to Jobber on this server. Edit the visit in Jobber.',
        );
      const title = input.title?.trim();
      await tx.inspection.update({
        where: { id },
        data: { ...(title ? { jobberVisitTitle: title } : {}), jobberVisitDetails: input.details.trim() || null },
      });
      await this.audit(tx, user, 'JOBBER_VISIT_EDITED', id, { titleChanged: Boolean(title) });
      await this.pushVisitEdit(tx, user, id, JobberOutboundKind.VISIT_EDIT);
    }, ADMIN_TRANSACTION_OPTIONS);
    await this.cacheInvalidation?.publish({ type: 'inspection.changed', organizationId: user.organizationId });
    return this.inspection(user, id);
  }

  /** The last fifty notifications, newest first, as the bell shows them. */
  async organizationNotifications(user: AuthenticatedUser) {
    const rows = await this.prisma.organizationNotification.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, kind: true, title: true, body: true, inspectionId: true, createdAt: true },
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      inspectionId: row.inspectionId,
      occurredAt: row.createdAt.toISOString(),
    }));
  }

  async updateInspection(user: AuthenticatedUser, id: string, input: UpdateAdminInspectionDto) {
    const existing = await this.requireInspection(user.organizationId, id);
    /**
     * A visit the technician has submitted is done (`DONE_INSPECTION_STATUSES`).
     *
     * This used to wait for COMPLETED, which with nobody finalizing never came:
     * a walked visit could be re-dated or cancelled, and the change pushed to a
     * Jobber visit already marked complete.
     */
    if (isDoneInspectionStatus(existing.status) || existing.status === InspectionStatus.CANCELLED)
      throw new ApplicationError(
        409,
        'INSPECTION_FINALIZED',
        'This visit has been done or cancelled, so it can no longer be changed.',
      );
    if (input.status === 'CANCELLED' && !input.cancellationReason)
      throw new ApplicationError(
        422,
        'CANCELLATION_REASON_REQUIRED',
        'Provide a cancellation reason.',
      );
    /**
     * A Jobber visit is rescheduled in Jobber.
     *
     * Jobber is the scheduling source of record, and the sync copies its date
     * over any visit still scheduled here whose date differs. A date changed
     * here therefore did not stay changed: one property's move-in was
     * re-dated at 1:28 PM and the sync restored Jobber's date at 1:30, with
     * nothing on the page to say it would. Refused instead, naming where the
     * change has to be made. The same day sent back is not a change — the edit
     * form always sends the date.
     */
    const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : undefined;
    const newDay = scheduledAt ? scheduledAt.toISOString().slice(0, 10) : null;
    const movesDay = Boolean(newDay && newDay !== existing.scheduledAt.toISOString().slice(0, 10));
    const movesJobberVisit = movesDay && Boolean(existing.jobberVisitId);
    /**
     * Unless the console's edits are pushed to Jobber, in which case the new day
     * is sent there and the sync holds off until it has gone (see
     * `pendingConsoleEdits`), so it stays changed.
     */
    if (movesJobberVisit && !getJobberConfig().pushEditsEnabled)
      throw new ApplicationError(
        409,
        'SCHEDULED_IN_JOBBER',
        'This visit is scheduled in Jobber. Change its date in Jobber and it will update here.',
      );
    /** The technician whose assignment a cancel ended, to be told after the commit. */
    let cancelledFor: string | null = null;
    const updated = await this.prisma.$transaction(async (tx) => {
      if (scheduledAt) {
        // Same rule as creation, and it has to stay the same rule: rescheduling
        // an HVAC visit onto a day that already holds a finished move-in is the
        // identical situation, and this check carried the identical two faults —
        // no type, and terminal work still counted as a clash.
        const duplicate = await tx.inspection.findFirst({
          where: {
            id: { not: id },
            organizationId: user.organizationId,
            propertywareBuildingId: existing.propertywareBuildingId,
            propertywareUnitId: existing.propertywareUnitId,
            inspectionType: existing.inspectionType,
            scheduledAt,
            status: { notIn: [InspectionStatus.COMPLETED, InspectionStatus.CANCELLED] },
          },
        });
        if (duplicate)
          throw new ApplicationError(
            409,
            'DUPLICATE_INSPECTION',
            'An inspection of this type is already scheduled for this unit at that time.',
          );
      }
      /**
       * The same 409 the check above raises, for the case the check cannot see.
       *
       * `Inspection_scheduled_booking_key` now backs that findFirst, so a
       * reschedule that races another one loses at the database instead of
       * writing a second booking. Without this mapping that race surfaced as an
       * unhandled Prisma error — a 500 on an action the API already has a
       * precise answer for.
       */
      const updated = await this.mapDuplicateBooking(() => tx.inspection.update({
        where: { id },
        data: {
          scheduledAt,
          // A visit Jobber had at a clock time keeps that time on its new day.
          ...(movesJobberVisit && newDay ? movedWindow(existing, newDay) : {}),
          priority: input.priority,
          internalNotes: input.internalNotes,
          /**
           * Absent means "leave it alone"; empty means "clear it".
           *
           * `?.trim() || undefined` would collapse those two, so a reviewer who
           * deleted a comment would watch it reappear — the field would stay on
           * a report they had just removed it from. Null is what clears it, and
           * the report prints no heading over a null.
           */
          nextInspectionAlert: emptyToNull(input.nextInspectionAlert),
          maintenanceComments: emptyToNull(input.maintenanceComments),
          generalComments: emptyToNull(input.generalComments),
          status: input.status as InspectionStatus | undefined,
          cancelledAt: input.status === 'CANCELLED' ? new Date() : undefined,
          cancellationReason: input.cancellationReason,
        },
      }));
      /**
       * A benefit-package visit's plan stop moves with it, to the Date just
       * written. The rebuild reads the stop's day, and once Jobber has the new
       * day too the sync sees nothing to change, so nothing else would move it.
       * Only on a new day: the date the edit form always sends back moves
       * nothing, even for a stop that already disagrees.
       */
      const planStop =
        movesDay && scheduledAt ? await moveStopWithVisit(tx, user.organizationId, id, scheduledAt) : null;
      const current =
        input.status === 'CANCELLED'
          ? await tx.inspectionAssignment.findFirst({
              where: { inspectionId: id, isCurrent: true },
            })
          : null;
      cancelledFor = current?.technicianId ?? null;
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
        { ...input, closedAssignmentId: current?.id, ...(planStop ? { planStop } : {}) },
      );
      if (movesJobberVisit) await this.pushVisitEdit(tx, user, id, JobberOutboundKind.VISIT_RESCHEDULE);
      if (input.status === 'CANCELLED' && existing.jobberVisitId)
        await this.pushVisitEdit(tx, user, id, JobberOutboundKind.VISIT_CANCEL);
      return updated;
    }, ADMIN_TRANSACTION_OPTIONS);
    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    /**
     * Told, and the job leaves their phone at once (the office, 2026-10-07:
     * "notify and remove"). It used to wait for their next refresh -- a minute
     * away with the app open, and never on a job screen already showing it.
     */
    if (cancelledFor) {
      const building = existing.propertywareBuildingId
        ? await this.prisma.propertywareBuilding.findUnique({
            where: { id: existing.propertywareBuildingId },
            select: { name: true, addressLine1: true },
          })
        : null;
      this.technicianEvents?.publish(
        cancelledFor,
        id,
        'CANCELLED',
        jobInWords(building?.addressLine1 || building?.name, existing.scheduledAt),
      );
    }
    return updated;
  }

  /**
   * Finalize (complete) an inspection — a human-only decision (spec §11).
   * Blocked while required review items remain (findings pending review or media
   * still processing) unless a documented override reason is supplied, which is
   * recorded in the audit trail. Only a principal with `inspections:finalize`
   * reaches this method (enforced by the controller guard).
   */
  /**
   * Close an inspection the technician never submitted.
   *
   * `finalizeInspection` is the end of the review workflow and only accepts an
   * inspection that has *entered* it — submitted, under review, TBD or
   * follow-up. That leaves no way to close a SCHEDULED one, and those exist in
   * numbers: the walk happened in Inspect & Cloud, the evidence arrives by
   * import, and no technician ever touched the record here. Before this the
   * office could import a report into such an inspection and then watch it sit
   * as "Scheduled" for ever.
   *
   * Every type, because nothing about this is type-specific.
   *
   * **Completed, deliberately not finalized.** `finalizedAt` freezes evidence
   * permanently — photograph deletion and area renaming both key on it — and
   * this is a scheduling correction, not a sign-off on evidence nobody has
   * reviewed. Leaving it null keeps the ordinary review and finalize path
   * available afterwards. The same reasoning the Jobber sync applies when it
   * closes an inspection Jobber has already finished.
   *
   * A reason is required rather than optional: this bypasses the submit and
   * review steps, so the audit row has to say why on behalf of somebody who
   * will read it much later.
   */
  async completeInspection(user: AuthenticatedUser, id: string, input: CompleteInspectionDto) {
    const existing = await this.requireInspection(user.organizationId, id);
    if (FROZEN_INSPECTION_STATUSES.includes(existing.status))
      throw new ApplicationError(
        409,
        'INSPECTION_ALREADY_CLOSED',
        existing.status === InspectionStatus.CANCELLED
          ? 'A cancelled inspection cannot be completed.'
          : 'This inspection is already complete.',
      );

    const updated = await this.prisma.$transaction(async (tx) => {
      const inspection = await tx.inspection.update({
        where: { id },
        data: {
          status: InspectionStatus.COMPLETED,
          completedAt: new Date(),
          // Whatever was holding it open no longer is — it has been closed by
          // hand, and leaving these set would show a reason against a finished
          // inspection.
          completionBlockedReason: null,
          tbdReason: null,
        },
      });
      await this.audit(tx, user, 'INSPECTION_COMPLETED_BY_ADMIN', id, {
        previousStatus: existing.status,
        reason: input.reason,
        // Says plainly that the review workflow was skipped, so a later reader
        // does not mistake this for a finalized inspection.
        finalized: false,
      });
      return inspection;
    }, ADMIN_TRANSACTION_OPTIONS);

    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    return updated;
  }

  async finalizeInspection(user: AuthenticatedUser, id: string, input: FinalizeInspectionDto) {
    const existing = await this.requireInspection(user.organizationId, id);
    this.assertReviewable(existing.status);
    const [pendingFindings, unfinishedMedia] = await Promise.all([
      /**
       * Defects only — the room condition summary is deliberately excluded.
       *
       * It is stored as a finding row (findingType NO_CHANGE, title "Room
       * condition summary") but it is narrative, not a defect, and the review
       * screen filters it out of the findings list on purpose. Counting it here
       * produced the worst kind of blocker: the dialog said "1 finding awaiting
       * review" while the Findings tab showed one finding, approved, and the
       * area read "1 of 1 reviewed". There was nothing the administrator could
       * click to clear it.
       *
       * A gate that can only be passed by typing an override reason every time
       * is not a safety gate — it teaches people to override reflexively, which
       * is precisely how a genuinely unreviewed defect gets finalized. This now
       * counts what the reviewer can actually see and act on, matching the
       * exclusion `area-evidence.service` already applies to the same rows.
       */
      this.prisma.inspectionFinding.findMany({
        where: {
          inspectionId: id,
          reviewStatus: FindingReviewStatus.PENDING_REVIEW,
          NOT: { ...ROOM_SUMMARY_WHERE },
        },
        select: { title: true, propertyArea: { select: { name: true } } },
        take: 20,
      }),
      this.prisma.inspectionMedia.findMany({
        where: {
          inspectionId: id,
          processingStatus: {
            in: [MediaProcessingStatus.PENDING, MediaProcessingStatus.PROCESSING],
          },
        },
        select: { inspectionArea: { select: { propertyArea: { select: { name: true } } } } },
        take: 20,
      }),
    ]);
    if ((pendingFindings.length || unfinishedMedia.length) && !input.overrideReason)
      throw new ApplicationError(
        409,
        'INSPECTION_HAS_UNRESOLVED_ITEMS',
        // Names what is blocking, and mentions only the categories that
        // actually are. The old wording always printed both counts, so a
        // reviewer read "and 0 recording(s) still processing" and had to work
        // out for themselves that the zero was not the problem.
        describeFinalizeBlockers(pendingFindings, unfinishedMedia),
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
        // Counts, not the rows: the audit records that an override happened and
        // how much was outstanding, which is what a later reader needs. The
        // titles are already in the findings themselves.
        pendingFindings: pendingFindings.length,
        unfinishedMedia: unfinishedMedia.length,
        override: pendingFindings.length + unfinishedMedia.length > 0,
        overrideReason: input.overrideReason ?? null,
      });
      // Inside the transaction on purpose: "finalized" and "Jobber will be
      // told" commit together. Calling Jobber here instead would let a network
      // error roll back a sign-off that has already frozen the evidence.
      // A no-op for inspections this app scheduled itself.
      await enqueueJobberCompletion(tx, {
        organizationId: user.organizationId,
        inspectionId: id,
        reportOwnerId: user.id,
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
      metadata: {
        dueAt: input.dueAt ?? null,
        tasks: input.tasks ?? null,
        reason: input.reason ?? null,
      },
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
    // Ids, not just a count: each of these technicians has to be told, and the
    // count alone cannot address them.
    const currentAssignees = await this.prisma.inspectionAssignment.findMany({
      where: { inspectionId: id, isCurrent: true },
      select: { technicianId: true },
    });
    const currentAssignments = currentAssignees.length;
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
          /**
           * Stored where the technician can read it.
           *
           * The reason was previously written only into the audit metadata,
           * which no technician endpoint reads — so a reopened inspection
           * reappeared in their queue with no explanation and the office had to
           * phone them. An audit row is for reconstructing what happened later;
           * this is for the person standing in the property now.
           */
          reopenReason: input.reason.trim() || null,
        },
      });
      if (count === 0)
        throw new ApplicationError(
          409,
          'INSPECTION_NOT_REOPENABLE',
          'The inspection changed while it was being reopened. Reload and try again.',
        );
      /**
       * Withdraw a completion push that has not gone to Jobber yet.
       *
       * Submission enqueues it, and the outbox drains on a five-minute cron —
       * so an inspection reopened within that window would still tell Jobber
       * the visit was finished, minutes after the office decided it was not.
       *
       * Only unsent tasks. One already delivered is left alone: the visit did
       * physically happen, which is what Jobber's completion records, and the
       * unique constraint keeps the next submission from sending it twice.
       */
      const withdrawn = await tx.jobberOutboundTask.deleteMany({
        where: {
          inspectionId: id,
          organizationId: user.organizationId,
          status: { in: [JobberOutboundStatus.PENDING, JobberOutboundStatus.FAILED] },
        },
      });
      await this.audit(tx, user, 'INSPECTION_REOPENED', id, {
        fromStatus: existing.status,
        reason: input.reason,
        wasFinalized: existing.status === InspectionStatus.COMPLETED,
        hadCurrentAssignment: currentAssignments > 0,
        // Recorded because it changes what Jobber will say about this visit.
        jobberPushWithdrawn: withdrawn.count > 0,
      });
    }, ADMIN_TRANSACTION_OPTIONS);
    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    /**
     * Tell the technician, in real time.
     *
     * This published only a cache invalidation before, which refreshes the web
     * console and reaches nobody in the field: the inspection reappeared in the
     * technician's queue on their next sixty-second poll, with no explanation
     * and no signal that anything had changed. Every other admin action that
     * moves work — assign, reassign, unassign, request evidence — already
     * publishes here.
     */
    for (const assignee of currentAssignees)
      this.technicianEvents?.publish(assignee.technicianId, id, 'REOPENED');
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
    /**
     * Told to the technician the moment it is written, not on their next poll.
     * A request exists because the office needs someone to go back to a
     * property; a notification that waits for a refresh interval is a
     * notification that arrives after they have driven away.
     *
     * After the commit, never inside it: announcing a request that then rolled
     * back sends a technician to an area with nothing waiting.
     */
    const assignee = await this.prisma.inspectionAssignment.findFirst({
      where: { inspectionId, isCurrent: true },
      select: { technicianId: true },
    });
    if (assignee)
      this.technicianEvents?.publish(assignee.technicianId, inspectionId, 'EVIDENCE_REQUESTED');
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

  /** Inspection areas for the workflow merge UI: the ones it inspects (`inspectedAreaWhere`). */
  async inspectionAreas(user: AuthenticatedUser, id: string) {
    const inspection = await this.requireInspection(user.organizationId, id);
    const areas = await this.prisma.inspectionArea.findMany({
      where: { inspectionId: id, ...inspectedAreaWhere(inspection.inspectionType) },
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
   * Adds approved areas to an inspection that is already under way.
   *
   * The area list an inspection covers is a snapshot: InspectionArea rows are
   * created once, at creation, from the property's approved layout. That split
   * is deliberate — the same room is assessed again at every visit, and last
   * quarter's answers must not appear as this quarter's — but it left no way to
   * correct a room the office notices is missing after a technician is already
   * carrying the job. Editing the property's layout does not reach an
   * inspection in the field, so the only routes were to cancel and rebook, or
   * to ask the technician to add it from the handset and approve it afterwards.
   *
   * APPROVED areas only. A manually created area is DRAFT until an
   * administrator approves the permanent layout, and accepting one here would
   * approve it as a side effect of a per-inspection decision — a different, and
   * larger, claim than the one being made.
   *
   * Eligibility is resolved exactly as it is at creation: the unit's own
   * approved areas when it has any, the building-level layout otherwise. Doing
   * it differently here is how an inspection ends up holding an area from a
   * layout it was never built against.
   *
   * MOVE_IN and MOVE_OUT are compared area by area against their baseline, so
   * an area added to one end has no counterpart at the other. That is allowed
   * rather than refused — a room nobody inspected is the worse outcome — but it
   * is recorded in the audit metadata, and the console warns before asking.
   */
  async addInspectionAreas(
    user: AuthenticatedUser,
    inspectionId: string,
    input: AddInspectionAreasDto,
  ) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId: user.organizationId },
      select: {
        id: true,
        status: true,
        inspectionType: true,
        finalizedAt: true,
        propertywareBuildingId: true,
        propertywareUnitId: true,
      },
    });
    if (!inspection)
      throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');

    /**
     * Finalization freezes the evidence permanently, and an empty area added
     * after the fact would reopen a settled record — the report has been issued
     * and may already have been charged against a deposit.
     */
    if (inspection.finalizedAt)
      throw new ApplicationError(
        409,
        'INSPECTION_FINALIZED',
        'This inspection has been finalized. Its areas can no longer be changed.',
      );
    if (
      inspection.status === InspectionStatus.CANCELLED ||
      inspection.status === InspectionStatus.COMPLETED
    )
      throw new ApplicationError(
        409,
        'INSPECTION_NOT_EDITABLE',
        'A completed or cancelled inspection cannot take new areas.',
      );

    /**
     * The building is nullable on Inspection, and without one there is no
     * approved layout to choose from — so this is refused rather than narrowed
     * to an empty eligible set, which would report every id as invalid and send
     * the caller looking for a permissions problem.
     */
    const propertyId = inspection.propertywareBuildingId;
    if (!propertyId)
      throw new ApplicationError(
        409,
        'INSPECTION_HAS_NO_PROPERTY',
        'This inspection is not linked to a property, so it has no approved areas to add.',
      );

    const requestedIds = [...new Set(input.propertyAreaIds)];
    const areaFilter = {
      propertyId,
      status: PropertyAreaStatus.APPROVED,
      archivedAt: null,
    };
    const unitAreas = inspection.propertywareUnitId
      ? await this.prisma.propertyArea.findMany({
          where: { ...areaFilter, unitId: inspection.propertywareUnitId },
          select: { id: true, name: true, source: true },
        })
      : [];
    const onTheProperty = unitAreas.length
      ? unitAreas
      : await this.prisma.propertyArea.findMany({
          where: { ...areaFilter, unitId: null },
          select: { id: true, name: true, source: true },
        });

    /**
     * A room walk can only take rooms.
     *
     * `layoutAreasFor` is what scopes an inspection at creation, and this did
     * not use it -- so every area on the property was addable here, including
     * the ones that are not rooms. An HVAC visit's subjects live on the
     * property as `SYSTEM` areas, and "AC filters", "Filters", "A/C unit",
     * "Thermostat" and "Attic" were being added to occupied inspections
     * through this route: 25 such rows across live inspections, none of them
     * ever photographed, next to a phone that has its own AC Filter Change
     * screen for that work.
     *
     * Only for the types that walk rooms. An HVAC or roof visit resolves its
     * own subjects -- `hvacSystemArea`, or the roof category -- and filtering
     * those here would leave them nothing to add.
     */
    const scope = areaScopeFor(inspection.inspectionType);
    const walksRooms = scope === AreaScope.ALL || scope === AreaScope.CHOSEN;
    const eligible = walksRooms ? layoutAreasFor(onTheProperty) : onTheProperty;
    const eligibleById = new Map(eligible.map((area) => [area.id, area]));

    /**
     * A rejected id is refused rather than quietly dropped. "Not approved yet"
     * and "belongs to another property" are different mistakes with the same
     * symptom, and silently adding three of four areas produces an inspection
     * missing a room nobody notices until a technician is standing in it.
     */
    const unknown = requestedIds.filter((id) => !eligibleById.has(id));
    if (unknown.length)
      throw new ApplicationError(
        422,
        'INVALID_AREA_SELECTION',
        'Select only approved areas belonging to this property. An area that is still a draft must be approved first.',
      );

    const existingAreas = await this.prisma.inspectionArea.findMany({
      where: { inspectionId, propertyAreaId: { in: requestedIds } },
      select: { propertyAreaId: true },
    });
    const alreadyPresent = new Set(existingAreas.map((area) => area.propertyAreaId));
    const toAdd = requestedIds.filter((id) => !alreadyPresent.has(id));
    if (!toAdd.length)
      throw new ApplicationError(
        409,
        'AREAS_ALREADY_PRESENT',
        'Every area selected is already part of this inspection.',
      );

    // Ids, not a count: each of these technicians has to be told, and the count
    // alone cannot address them.
    const currentAssignees = await this.prisma.inspectionAssignment.findMany({
      where: { inspectionId, isCurrent: true },
      select: { technicianId: true },
    });
    const comparisonAffected =
      inspection.inspectionType === InspectionType.MOVE_IN ||
      inspection.inspectionType === InspectionType.MOVE_OUT;

    await this.prisma.$transaction(async (tx) => {
      // skipDuplicates rather than a second existence check: the unique index on
      // (inspectionId, propertyAreaId) is the real guard, and two administrators
      // adding the same missed room at once should produce one area and no error.
      await tx.inspectionArea.createMany({
        data: toAdd.map((propertyAreaId) => ({ inspectionId, propertyAreaId })),
        skipDuplicates: true,
      });
      await this.audit(tx, user, 'INSPECTION_AREAS_ADDED', inspectionId, {
        propertyAreaIds: toAdd,
        // Names too: a property area can be renamed or archived later, and an
        // audit row of bare uuids cannot be read back into what was decided.
        areaNames: toAdd.map((id) => eligibleById.get(id)?.name ?? null),
        inspectionType: inspection.inspectionType,
        fromStatus: inspection.status,
        // The baseline comparison will show these as unmatched. Worth stating
        // here rather than leaving someone to infer it from the report.
        comparisonAffected,
        notifiedTechnicians: currentAssignees.length,
      });
    }, ADMIN_TRANSACTION_OPTIONS);

    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    /**
     * Tell the technician, in real time.
     *
     * Without this the area appears on their next sixty-second poll with no
     * signal that anything changed — and if they have already left the property,
     * a poll is far too late. UPDATED was declared as an event kind from the
     * start and never published by anything; this is what it was for.
     */
    for (const assignee of currentAssignees)
      this.technicianEvents?.publish(assignee.technicianId, inspectionId, 'UPDATED');
    return this.inspection(user, inspectionId);
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
      throw new ApplicationError(422, 'INVALID_MERGE', 'Choose two different areas to merge.');
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
      await this.pushVisitEdit(tx, user, inspectionId, JobberOutboundKind.VISIT_ASSIGN);
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
      await this.pushVisitEdit(tx, user, inspectionId, JobberOutboundKind.VISIT_ASSIGN);
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
      await this.pushVisitEdit(tx, user, inspectionId, JobberOutboundKind.VISIT_ASSIGN);
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
    /**
     * Free text, matched against the property the visit is at.
     *
     * The rule and the reasoning live in `assignment-search.ts`, because this
     * list is two queries -- the assignments, and the inspections nobody is on
     * -- and the filter has to be identical on both.
     */
    const matchesSearch = assignmentPropertySearch(query.search);
    /**
     * A cancelled visit is not an assignment to manage, unless asked for by
     * name (2026-10-07): the unassigned half listed every one as waiting for a
     * technician, and the other half a cancelled one still carrying its own.
     */
    const statusFilter: Prisma.InspectionWhereInput = query.inspectionStatus
      ? { status: query.inspectionStatus as InspectionStatus }
      : { status: { not: InspectionStatus.CANCELLED } };
    const assignmentWhere: Prisma.InspectionAssignmentWhereInput = {
      inspection: {
        organizationId: user.organizationId,
        ...matchesSearch,
        ...(query.inspectionId ? { id: query.inspectionId } : {}),
        ...(query.propertyId ? { propertywareBuildingId: query.propertyId } : {}),
        ...statusFilter,
        ...(query.inspectionType ? { inspectionType: query.inspectionType } : {}),
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
      nextInspectionAlert: true,
      maintenanceComments: true,
      generalComments: true,
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
      // The same filter, against the other half of this list. Unassigned rows
      // come from a separate query, so leaving it off here would let every
      // unassigned visit through a search that had narrowed everything else.
      ...matchesSearch,
      ...(query.inspectionId ? { id: query.inspectionId } : {}),
      assignments: { none: { isCurrent: true } },
      ...(query.propertyId ? { propertywareBuildingId: query.propertyId } : {}),
      ...statusFilter,
      // The same filter, and the half that is easy to forget. These rows come
      // from a separate query against Inspection, so without it every section
      // would list every unassigned inspection regardless of type — and those
      // are precisely the rows somebody opens a section to find.
      ...(query.inspectionType ? { inspectionType: query.inspectionType } : {}),
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
    const page = await this.cacheRead({
      resource: 'technicians',
      scope: user.organizationId,
      query,
      loader: () => this.loadTechnicians(user, query),
    });
    /**
     * Presence is attached *outside* the cache, deliberately.
     *
     * Everything else on this row survives being a minute stale; whether
     * somebody is connected right now does not. Loading it inside the loader
     * would freeze it for the life of the cache entry, so the dot would go on
     * claiming someone is online long after they closed the app — the one
     * failure that makes an indicator worse than none.
     */
    const presence = this.presence.presenceForMany(page.items.map((item) => item.id));
    return {
      ...page,
      items: page.items.map((item) => ({
        ...item,
        ...(presence[item.id] ?? { isOnline: false, lastSeenAt: null }),
      })),
    };
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
            // A cancelled visit is no one's work (2026-10-07).
            where: {
              ...workloadWhere,
              isCurrent: true,
              inspection: {
                organizationId: user.organizationId,
                status: { not: InspectionStatus.CANCELLED },
              },
            },
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
                // Submitted is done (`DONE_INSPECTION_STATUSES`).
                status: { in: DONE_INSPECTION_STATUSES },
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
        _count: {
          select: {
            assignments: {
              where: {
                isCurrent: true,
                inspection: { status: { not: InspectionStatus.CANCELLED } },
              },
            },
          },
        },
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
        // A cancelled visit does not keep a leaver's account open.
        where: {
          technicianId: id,
          isCurrent: true,
          inspection: { status: { not: InspectionStatus.CANCELLED } },
        },
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
  private notifyAssignmentByEmail(
    organizationId: string,
    inspectionId: string,
    technicianId: string,
  ) {
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
              reasonCode: true,
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
              reasonCode: record.reviews[0].reasonCode,
              reviewerName: record.reviews[0].reviewer.displayName,
              createdAt: record.reviews[0].createdAt,
            }
          : null,
      })),
      total,
      query,
    );
  }

  /**
   * Approve or reject one of the AI's findings.
   *
   * **Findings are decided after finalization too** (the office's rule,
   * 2026-10-03), and so are their corrections, the findings a reviewer adds,
   * the area's review mark, a re-run of the AI and the stills filed under a
   * finding. Finalizing -- like the technician ending the job -- closes the
   * *visit*: its status, its Jobber completion and the technician's paid time.
   * Deciding what the AI said is the office's work afterwards, for the reports
   * and the move-in comparison, and none of these touch the inspection's
   * status. Reopening to get at them would undo exactly what must stay done.
   * What finalization still freezes is what was captured: the recordings and
   * photos, the checklist answers, the areas.
   *
   * Only APPROVED findings reach a shared report, so a decision taken later
   * reaches it then, which is the point. Each is audited with
   * `afterFinalization`.
   */
  async reviewFinding(
    user: AuthenticatedUser,
    findingId: string,
    status: 'APPROVED' | 'REJECTED',
    reason?: string,
    // Only a rejection carries one; it is what the AI is later shown as a lesson.
    reasonCode?: FindingRejectReason,
  ) {
    const code = status === 'REJECTED' ? (reasonCode ?? null) : null;
    const outcome = await this.prisma.$transaction(async (tx) => {
      const finding = await tx.inspectionFinding.findFirst({
        where: { id: findingId, inspection: { organizationId: user.organizationId } },
        select: {
          id: true,
          inspectionId: true,
          reviewStatus: true,
          inspection: { select: { finalizedAt: true } },
        },
      });
      if (!finding) throw new ApplicationError(404, 'FINDING_NOT_FOUND', 'Finding was not found.');
      const nextStatus =
        status === 'APPROVED' ? FindingReviewStatus.APPROVED : FindingReviewStatus.REJECTED;
      // Re-sending the same decision is a no-op so review clicks are idempotent.
      if (finding.reviewStatus === nextStatus)
        return {
          finding: { id: finding.id, inspectionId: finding.inspectionId, reviewStatus: finding.reviewStatus },
          review: null,
        };
      const review = await tx.findingReview.create({
        data: {
          findingId: finding.id,
          reviewerId: user.id,
          status: nextStatus,
          reason,
          reasonCode: code,
        },
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
        {
          inspectionId: finding.inspectionId,
          reason: reason ?? null,
          reasonCode: code,
          reviewId: review.id,
          afterFinalization: Boolean(finding.inspection.finalizedAt),
        },
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
   * Add a finding the AI missed, written by the reviewer who saw it.
   *
   * A person's finding, so it is decided as it is written: approved, with the
   * approval recorded and audited, never waiting in the AI's review queue. It
   * belongs to one of the area's recordings at the moment given, which is what
   * lets its frame be filed as its photograph and the AI be shown later what
   * it missed. The tenant lean is left undetermined: who pays is decided on
   * the charge, by a person, as for every finding. Allowed after
   * finalization, like every findings decision: see `reviewFinding`.
   */
  async addFinding(
    user: AuthenticatedUser,
    inspectionId: string,
    areaId: string,
    input: {
      recordingId: string;
      atSeconds?: number;
      title: string;
      description: string;
      severity: Severity;
      findingType: FindingType;
      category: string;
      note?: string;
    },
  ) {
    const created = await this.prisma.$transaction(async (tx) => {
      const area = await tx.inspectionArea.findFirst({
        where: { id: areaId, inspectionId, inspection: { organizationId: user.organizationId } },
        select: {
          id: true,
          propertyAreaId: true,
          propertyArea: { select: { name: true } },
          inspection: { select: { finalizedAt: true } },
        },
      });
      if (!area)
        throw new ApplicationError(404, 'INSPECTION_AREA_NOT_FOUND', 'That area was not found.');
      const media = await tx.inspectionMedia.findFirst({
        where: { id: input.recordingId, inspectionAreaId: area.id, organizationId: user.organizationId },
        select: { id: true, durationSeconds: true },
      });
      if (!media)
        throw new ApplicationError(
          404,
          'INSPECTION_MEDIA_NOT_FOUND',
          'That recording is not one of this area’s.',
        );
      const at =
        input.atSeconds === undefined
          ? 0
          : Math.min(Math.max(0, Math.round(input.atSeconds)), Math.max(0, media.durationSeconds));
      const note = input.note?.trim() || null;
      const finding = await tx.inspectionFinding.create({
        data: {
          inspectionId,
          propertyAreaId: area.propertyAreaId,
          inspectionMediaId: media.id,
          source: FindingSource.REVIEWER,
          findingType: input.findingType,
          category: input.category.trim(),
          title: input.title.trim(),
          description: input.description.trim(),
          baselineCondition: '',
          comparisonResult: REVIEWER_COMPARISON[input.findingType],
          videoTimestampStart: at,
          videoTimestampEnd: at,
          severity: input.severity,
          possibleResponsibility: ResponsibilityClassification.UNDETERMINED,
          confidence: 1,
          recommendedReview: '',
          reviewStatus: FindingReviewStatus.APPROVED,
        },
        select: { id: true, inspectionId: true, reviewStatus: true, title: true },
      });
      const review = await tx.findingReview.create({
        data: {
          findingId: finding.id,
          reviewerId: user.id,
          status: FindingReviewStatus.APPROVED,
          reason: note,
        },
        select: { id: true },
      });
      // On the inspection, so its Recent activity says who added what, where.
      await this.audit(tx, user, 'FINDING_ADDED', inspectionId, {
        findingId: finding.id,
        inspectionAreaId: area.id,
        areaName: area.propertyArea.name,
        severity: input.severity,
        findingType: input.findingType,
        atSeconds: input.atSeconds === undefined ? null : at,
        reviewId: review.id,
        afterFinalization: Boolean(area.inspection.finalizedAt),
      });
      return finding;
    }, ADMIN_TRANSACTION_OPTIONS);
    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    return created;
  }

  /**
   * Correct an AI finding and approve it in one step, rather than rejecting a
   * finding that was nearly right and writing it again by hand.
   *
   * Only a finding still waiting for review: a decided one is changed by
   * deciding it again, so the record of who kept what stays a sequence of
   * whole decisions. The correction is kept beside the decision, before and
   * after, which is what the AI is later shown as a lesson. Allowed after
   * finalization, like every findings decision: see `reviewFinding`.
   */
  async editFinding(
    user: AuthenticatedUser,
    findingId: string,
    input: {
      title: string;
      description: string;
      severity: Severity;
      findingType: FindingType;
      category: string;
      note?: string;
    },
  ) {
    const after = {
      title: input.title.trim(),
      description: input.description.trim(),
      severity: input.severity,
      findingType: input.findingType,
      category: input.category.trim(),
    };
    const outcome = await this.prisma.$transaction(async (tx) => {
      const finding = await tx.inspectionFinding.findFirst({
        where: { id: findingId, inspection: { organizationId: user.organizationId } },
        select: {
          id: true,
          inspectionId: true,
          reviewStatus: true,
          title: true,
          description: true,
          severity: true,
          findingType: true,
          category: true,
          inspection: { select: { finalizedAt: true } },
        },
      });
      if (!finding) throw new ApplicationError(404, 'FINDING_NOT_FOUND', 'Finding was not found.');
      if (finding.reviewStatus !== FindingReviewStatus.PENDING_REVIEW)
        throw new ApplicationError(
          409,
          'FINDING_ALREADY_DECIDED',
          'This finding was already decided. Reload to see the decision.',
        );
      const before = {
        title: finding.title,
        description: finding.description,
        severity: finding.severity,
        findingType: finding.findingType,
        category: finding.category,
      };
      const changed = (Object.keys(after) as Array<keyof typeof after>).filter(
        (field) => before[field] !== after[field],
      );
      const note = input.note?.trim() || null;
      // Conditional on the status read above, so two reviewers correcting the
      // same finding at once cannot both win: the second waits on the row,
      // finds it decided, and is told so.
      const claimed = await tx.inspectionFinding.updateMany({
        where: { id: finding.id, reviewStatus: FindingReviewStatus.PENDING_REVIEW },
        // APPROVED, not EDITED: an approved finding is what the report, the
        // charges and the area's status read, and this one is approved.
        data: { ...after, reviewStatus: FindingReviewStatus.APPROVED },
      });
      if (claimed.count === 0)
        throw new ApplicationError(
          409,
          'FINDING_ALREADY_DECIDED',
          'This finding was already decided. Reload to see the decision.',
        );
      // Nothing changed is an approval, recorded as one rather than as a
      // correction that taught the AI nothing.
      const review = await tx.findingReview.create({
        data: {
          findingId: finding.id,
          reviewerId: user.id,
          status: changed.length ? FindingReviewStatus.EDITED : FindingReviewStatus.APPROVED,
          reason: note,
          editedValue: changed.length ? { before, after, changed } : undefined,
        },
      });
      const updated = await tx.inspectionFinding.findUniqueOrThrow({
        where: { id: finding.id },
        select: {
          id: true,
          inspectionId: true,
          reviewStatus: true,
          title: true,
          description: true,
          severity: true,
          findingType: true,
          category: true,
        },
      });
      await this.audit(
        tx,
        user,
        changed.length ? 'FINDING_EDITED' : 'FINDING_APPROVED',
        finding.id,
        {
          inspectionId: finding.inspectionId,
          changed,
          reason: note,
          reviewId: review.id,
          afterFinalization: Boolean(finding.inspection.finalizedAt),
        },
        'InspectionFinding',
      );
      return updated;
    }, ADMIN_TRANSACTION_OPTIONS);
    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    return outcome;
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
       * A planned visit deleted here is taken off Jobber too (the office,
       * 2026-10-01: a visit deleted on either side goes from both). Before
       * this the visit stayed in Jobber for good, and the sync skipped it as
       * an import whose inspection no longer existed.
       *
       * Queued with no inspection, which is about to go -- the cancellation
       * needs only the visit and its job. Only for a SCHEDULED one: work begun
       * or done is Jobber's history as much as ours. And only while console
       * edits are pushed at all; with them off, Jobber's calendar is not this
       * console's to change.
       */
      const jobberVisit = await tx.inspection.findUnique({
        where: { id },
        select: { status: true, jobberVisitId: true, jobberJobId: true },
      });
      const removeFromJobber = Boolean(
        jobberVisit?.jobberVisitId &&
          jobberVisit.status === InspectionStatus.SCHEDULED &&
          getJobberConfig().pushEditsEnabled,
      );
      if (removeFromJobber && jobberVisit?.jobberVisitId) {
        await tx.jobberOutboundTask.create({
          data: {
            organizationId: user.organizationId,
            inspectionId: null,
            jobberVisitId: jobberVisit.jobberVisitId,
            jobberJobId: jobberVisit.jobberJobId,
            kind: JobberOutboundKind.VISIT_CANCEL,
            createdById: user.id,
          },
        });
        // A person decided this visit is not an inspection any more.
        await tx.jobberVisitImport.updateMany({
          where: { organizationId: user.organizationId, jobberVisitId: jobberVisit.jobberVisitId },
          data: { status: JobberVisitImportStatus.IGNORED, inspectionId: null },
        });
      }

      // The rows themselves, in the order the schema demands (`erase-inspection.ts`).
      const erased = await eraseInspectionRows(tx, id);

      /**
       * Written last, inside the same transaction.
       *
       * `AuditLog.entityId` is a plain string with no foreign key to
       * `Inspection`, which is what lets the record outlive the row it
       * describes — the deletion is the one event whose evidence must survive
       * the thing it happened to.
       */
      await this.audit(tx, user, 'INSPECTION_DELETED', id, {
        ...erased,
        ...(removeFromJobber ? { jobberVisitId: jobberVisit?.jobberVisitId, removedFromJobber: true } : {}),
      });

      return {
        areas: erased.areas,
        recordings: erased.recordings,
        photos: erased.photos,
        findings: erased.findings,
        unlinkedInspections: erased.unlinkedBaselineOf + erased.unlinkedParentOf,
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
        // Needed by the reschedule clash check: two inspections are only the
        // same booking if they are the same kind of visit.
        inspectionType: true,
        // A Jobber visit's date is Jobber's to change; see `updateInspection`.
        scheduledAt: true,
        scheduledStartAt: true,
        scheduledEndAt: true,
        jobberVisitId: true,
      },
    });
    if (!inspection)
      throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
    return inspection;
  }

  /**
   * Turns a booking-index collision into the 409 the caller expects.
   *
   * Scoped to that one index by name: any other P2002 is a different constraint
   * and must not be reported as a duplicate booking.
   */
  private async mapDuplicateBooking<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        String((error.meta as { target?: unknown })?.target ?? '').includes(
          'Inspection_scheduled_booking_key',
        )
      )
        throw new ApplicationError(
          409,
          'DUPLICATE_INSPECTION',
          'An inspection of this type is already scheduled for this unit at that time.',
        );
      throw error;
    }
  }

  private requireAssignableInspection(status: InspectionStatus) {
    if (!ACTIVE_INSPECTION_STATUSES.includes(status))
      throw new ApplicationError(
        409,
        'INSPECTION_NOT_ASSIGNABLE',
        'A completed or cancelled inspection cannot be assigned.',
      );
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
