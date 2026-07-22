import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  FindingReviewStatus,
  InspectionStatus,
  InspectionType,
  Prisma,
  PropertyAreaStatus,
  UserRole,
} from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { CacheInvalidationService } from '../cache/cache-invalidation.service';
import { CacheService, type CacheReadOptions } from '../cache/cache.service';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { TechnicianEventsGateway } from '../realtime/technician-events.gateway';
import { InspectionMediaStorageService } from '../technician/inspection-media-storage.service';
import type {
  AdminFindingsQueryDto,
  AssignmentDto,
  AssignmentListQueryDto,
  AuditListQueryDto,
  CreateAdminInspectionDto,
  InspectionListQueryDto,
  LeaseListQueryDto,
  PortfolioListQueryDto,
  PaginationDto,
  PropertyListQueryDto,
  TechnicianListQueryDto,
  TechnicianStatusDto,
  UnitListQueryDto,
  UnassignDto,
  UpdateAdminInspectionDto,
} from './admin.dto';

const ACTIVE_INSPECTION_STATUSES: InspectionStatus[] = [
  InspectionStatus.SCHEDULED,
  InspectionStatus.IN_PROGRESS,
  InspectionStatus.PROCESSING,
  InspectionStatus.REVIEW_REQUIRED,
];

const ADMIN_TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5_000,
  timeout: 15_000,
} as const;

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
    return profile;
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
      portfolio: { isActive: true },
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
          portfolio: { select: { id: true, name: true, externalId: true } },
          _count: { select: { units: true, inspections: true } },
        },
      }),
      this.prisma.propertywareBuilding.count({ where }),
    ]);
    return this.page(items, total, query);
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
            leaseName: true,
            sourceStatus: true,
            startDate: true,
            endDate: true,
            scheduledMoveOutDate: true,
          },
        },
      },
    });
    if (!property) throw new ApplicationError(404, 'PROPERTY_NOT_FOUND', 'Property was not found.');
    return property;
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
      const approvedAreas = await tx.propertyArea.findMany({
        where: {
          propertyId: property.id,
          status: PropertyAreaStatus.APPROVED,
        },
        orderBy: { inspectionOrder: 'asc' },
        select: { id: true },
      });
      if (!approvedAreas.length)
        throw new ApplicationError(
          409,
          'NO_APPROVED_AREAS',
          'Upload or define the property floor plan and approve its areas before creating an inspection.',
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
      const inspection = await tx.inspection.create({
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
          propertySnapshot: this.propertySnapshot(property, unit),
          leaseSnapshot: lease ? this.leaseSnapshot(lease) : Prisma.JsonNull,
          areas: {
            create: approvedAreas.map((area) => ({ propertyAreaId: area.id })),
          },
        },
      });
      await this.audit(tx, user, 'INSPECTION_CREATED', inspection.id, {
        priority: input.priority,
        inspectionType: input.inspectionType,
        baselineInspectionId,
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
    if (inspection && input.technicianId)
      this.technicianEvents?.publish(input.technicianId, inspection.id, 'ASSIGNED');
    await this.cacheInvalidation?.publish({
      type: 'inspection.changed',
      organizationId: user.organizationId,
    });
    return inspection;
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
          completedAt: input.status === 'COMPLETED' ? new Date() : undefined,
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
        input.status === 'CANCELLED'
          ? 'INSPECTION_CANCELLED'
          : input.status === 'COMPLETED'
            ? 'INSPECTION_COMPLETED'
            : 'INSPECTION_UPDATED',
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
    if (outcome.shouldNotify)
      this.technicianEvents?.publish(input.technicianId, inspectionId, 'ASSIGNED');
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
      {
        provider: 'Supabase',
        status: status(Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)),
      },
      {
        provider: 'Deepgram',
        status: status(Boolean(process.env.DEEPGRAM_API_KEY || process.env.TRANSCRIPTION_API_KEY)),
      },
      { provider: 'Anthropic', status: status(Boolean(process.env.ANTHROPIC_API_KEY)) },
      {
        provider: 'Cloudflare Stream',
        status: status(
          Boolean(
            process.env.CLOUDFLARE_ACCOUNT_ID &&
            process.env.CLOUDFLARE_STREAM_API_TOKEN &&
            process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET,
          ),
        ),
        detail: 'Video upload is unavailable until this provider is configured.',
      },
      { provider: 'Sentry', status: status(Boolean(process.env.SENTRY_DSN)) },
      {
        provider: 'Redis',
        status: status(cacheStatus?.enabled ?? false, cacheStatus?.state === 'connected'),
        detail: cacheStatus?.state ?? 'disabled',
      },
    ];
  }

  private cacheRead<T>(options: CacheReadOptions<T>) {
    return this.cache ? this.cache.getOrLoad(options) : options.loader();
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
        ...(active ? { isActive: true, portfolio: { isActive: true } } : {}),
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
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: {
        id: true,
        inspectionAreaId: true,
        mimeType: true,
        durationSeconds: true,
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
    return records.map((record) => ({
      id: record.id,
      roomId: record.inspectionAreaId,
      roomName: record.inspectionArea.propertyArea.name,
      floorName: record.inspectionArea.propertyArea.floor?.name ?? null,
      roomCompletionStatus: record.inspectionArea.completionStatus,
      technicianName: record.technician.displayName,
      mimeType: record.mimeType,
      durationSeconds: record.durationSeconds,
      uploadStatus: record.uploadStatus,
      processingStatus: record.processingStatus,
      createdAt: record.createdAt,
      contentPath: `/api/v1/admin/media/${record.id}/content`,
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
      select: { id: true, providerMediaId: true, mimeType: true },
    });
    if (!record)
      throw new ApplicationError(404, 'INSPECTION_MEDIA_NOT_FOUND', 'Room video not found.');
    return {
      bytes: await this.mediaStorage.get(record.providerMediaId),
      mimeType: record.mimeType,
      fileName: `room-video-${record.id}.mp4`,
    };
  }

  async findings(user: AuthenticatedUser, inspectionId: string, query: AdminFindingsQueryDto) {
    await this.requireInspection(user.organizationId, inspectionId);
    const where = {
      inspectionId,
      inspection: { organizationId: user.organizationId },
      ...(query.reviewStatus
        ? { reviewStatus: query.reviewStatus as FindingReviewStatus }
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
      if (!finding)
        throw new ApplicationError(404, 'FINDING_NOT_FOUND', 'Finding was not found.');
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
        portfolio: property.portfolio.name,
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
