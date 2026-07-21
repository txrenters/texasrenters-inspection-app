import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../common/prisma.service';
import {
  PROPERTYWARE_SOURCE_SYSTEM,
  type PropertywareEntity,
} from '../../integrations/propertyware/propertyware.constants';
import { stableSourceHash } from '../../integrations/propertyware/propertyware.mapper';
import { propertywareDatabaseUpsertSchema } from '../../integrations/propertyware/propertyware.schemas';
import type {
  NormalizedPropertywareRecord,
  SyncMetrics,
  SyncMode,
  SyncRunStatus,
} from '../../integrations/propertyware/propertyware.types';

export type UpsertOutcome = 'created' | 'updated' | 'unchanged' | 'reactivated';

export interface PropertywarePopulationVerification {
  organizationId: string;
  verifiedAt: string;
  counts: Record<PropertywareEntity, { total: number; active: number; inactive: number }>;
  total: number;
  active: number;
  inactive: number;
}

export interface StoredSyncRun extends SyncMetrics {
  id: string;
  organizationId: string;
  syncType: SyncMode;
  requestedBy: string;
  status: SyncRunStatus;
  startedAt?: Date;
  completedAt?: Date;
  cursorStart?: Date;
  cursorEnd?: Date;
  errorSummary?: string;
  createdAt: Date;
}

export interface PropertywareSyncStore {
  acquireLock(lockKey: string, ownerId: string): Promise<boolean>;
  releaseLock(lockKey: string, ownerId: string): Promise<void>;
  createRun(organizationId: string, mode: SyncMode, requestedBy: string): Promise<StoredSyncRun>;
  updateRun(
    runId: string,
    status: SyncRunStatus,
    metrics: SyncMetrics,
    errorSummary?: string,
  ): Promise<void>;
  updateEntityRun(
    runId: string,
    entity: PropertywareEntity,
    status: 'RUNNING' | 'COMPLETED' | 'FAILED',
    metrics: SyncMetrics,
  ): Promise<void>;
  getRun(runId: string): Promise<unknown>;
  listRuns(organizationId: string): Promise<unknown[]>;
  listRunsPage(
    organizationId: string,
    query: {
      page: number;
      pageSize: number;
      status?: string;
      syncType?: string;
      from?: string;
      to?: string;
    },
  ): Promise<unknown>;
  listErrorsPage(
    organizationId: string,
    runId: string,
    query: { page: number; pageSize: number; entityType?: PropertywareEntity; resolved?: string },
  ): Promise<unknown>;
  getCursor(organizationId: string, entity: PropertywareEntity): Promise<Date | undefined>;
  saveCursor(
    organizationId: string,
    entity: PropertywareEntity,
    cursor: Date,
    reconciliation: boolean,
  ): Promise<void>;
  upsertRecord(
    organizationId: string,
    record: NormalizedPropertywareRecord,
    seenAt: Date,
  ): Promise<UpsertOutcome>;
  touchRecords(
    organizationId: string,
    entity: PropertywareEntity,
    externalIds: string[],
    seenAt: Date,
  ): Promise<void>;
  deactivateUnseen(
    organizationId: string,
    entity: PropertywareEntity,
    externalIds: Set<string>,
    seenAt: Date,
  ): Promise<number>;
  addError(input: {
    runId: string;
    entity: PropertywareEntity;
    externalId?: string;
    pageOffset?: number;
    code: string;
    message: string;
    retryable: boolean;
    fingerprint?: string;
  }): Promise<void>;
  listActive(
    entity: PropertywareEntity,
    organizationId: string,
    filters?: Record<string, string | undefined>,
  ): Promise<unknown[]>;
  listActivePage(
    entity: PropertywareEntity,
    organizationId: string,
    query: {
      page: number;
      pageSize: number;
      portfolioId?: string;
      propertyId?: string;
      unitId?: string;
      status?: string;
      search?: string;
    },
  ): Promise<unknown>;
  getActive(
    entity: PropertywareEntity,
    organizationId: string,
    id: string,
  ): Promise<unknown | null>;
  status(organizationId: string): Promise<unknown>;
  verifyPopulation(organizationId: string): Promise<PropertywarePopulationVerification>;
}

const emptyMetrics = (): SyncMetrics => ({
  recordsFetched: 0,
  recordsCreated: 0,
  recordsUpdated: 0,
  recordsUnchanged: 0,
  recordsDeactivated: 0,
  recordsReactivated: 0,
  recordsFailed: 0,
  pagesFetched: 0,
  warnings: 0,
});

interface MemoryRecord {
  record: NormalizedPropertywareRecord;
  sourceHash: string;
  firstSyncedAt: Date;
  lastSyncedAt: Date;
  lastSeenAt: Date;
  deactivatedAt?: Date;
}

@Injectable()
export class InMemoryPropertywareSyncStore implements PropertywareSyncStore {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly runs = new Map<string, StoredSyncRun>();
  private readonly cursors = new Map<string, Date>();
  private readonly errors: unknown[] = [];
  private readonly locks = new Map<string, { ownerId: string; expiresAt: number }>();

  async acquireLock(lockKey: string, ownerId: string) {
    const existing = this.locks.get(lockKey);
    if (existing && existing.expiresAt > Date.now()) return false;
    this.locks.set(lockKey, { ownerId, expiresAt: Date.now() + 30 * 60_000 });
    return true;
  }
  async releaseLock(lockKey: string, ownerId: string) {
    if (this.locks.get(lockKey)?.ownerId === ownerId) this.locks.delete(lockKey);
  }
  async createRun(organizationId: string, mode: SyncMode, requestedBy: string) {
    const run: StoredSyncRun = {
      id: randomUUID(),
      organizationId,
      syncType: mode,
      requestedBy,
      status: 'PENDING',
      createdAt: new Date(),
      ...emptyMetrics(),
    };
    this.runs.set(run.id, run);
    return run;
  }
  async updateRun(
    runId: string,
    status: SyncRunStatus,
    metrics: SyncMetrics,
    errorSummary?: string,
  ) {
    const run = this.runs.get(runId);
    if (!run) return;
    Object.assign(run, metrics, { status, errorSummary });
    if (status === 'RUNNING') run.startedAt = new Date();
    if (['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'].includes(status))
      run.completedAt = new Date();
  }
  async updateEntityRun(
    runId: string,
    entity: PropertywareEntity,
    status: 'RUNNING' | 'COMPLETED' | 'FAILED',
    metrics: SyncMetrics,
  ) {
    const run = this.runs.get(runId) as
      (StoredSyncRun & { entities?: Record<string, unknown> }) | undefined;
    if (run)
      run.entities = {
        ...(run.entities ?? {}),
        [entity]: { entityType: entity, status, ...metrics },
      };
  }
  async getRun(runId: string) {
    const run = this.runs.get(runId);
    return run ? this.runItem(run, true) : null;
  }
  async listRuns(organizationId: string) {
    return [...this.runs.values()]
      .filter((run) => run.organizationId === organizationId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async listRunsPage(
    organizationId: string,
    query: {
      page: number;
      pageSize: number;
      status?: string;
      syncType?: string;
      from?: string;
      to?: string;
    },
  ) {
    const filtered = ((await this.listRuns(organizationId)) as StoredSyncRun[]).filter(
      (run) =>
        (!query.status || run.status === query.status) &&
        (!query.syncType || run.syncType === query.syncType) &&
        (!query.from || run.createdAt >= new Date(query.from)) &&
        (!query.to || run.createdAt <= new Date(query.to)),
    );
    const start = (query.page - 1) * query.pageSize;
    return {
      items: filtered.slice(start, start + query.pageSize).map((run) => this.runItem(run, false)),
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length,
      totalPages: Math.ceil(filtered.length / query.pageSize),
    };
  }
  async listErrorsPage(
    organizationId: string,
    runId: string,
    query: { page: number; pageSize: number; entityType?: PropertywareEntity; resolved?: string },
  ) {
    const run = this.runs.get(runId);
    const filtered =
      run && run.organizationId === organizationId
        ? (
            this.errors as Array<{
              id: string;
              runId: string;
              entity: PropertywareEntity;
              code: string;
              message: string;
              retryable: boolean;
              createdAt: Date;
              resolvedAt?: Date;
            }>
          ).filter(
            (error) =>
              error.runId === runId &&
              (!query.entityType || error.entity === query.entityType) &&
              (query.resolved === undefined ||
                Boolean(error.resolvedAt) === (query.resolved === 'true')),
          )
        : [];
    const start = (query.page - 1) * query.pageSize;
    return {
      items: filtered.slice(start, start + query.pageSize).map((error) => ({
        id: error.id,
        entityType: error.entity,
        errorCode: error.code,
        sanitizedMessage: error.message,
        retryable: error.retryable,
        createdAt: error.createdAt,
        resolvedAt: error.resolvedAt,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length,
      totalPages: Math.ceil(filtered.length / query.pageSize),
    };
  }
  async getCursor(organizationId: string, entity: PropertywareEntity) {
    return this.cursors.get(`${organizationId}:${entity}`);
  }
  async saveCursor(organizationId: string, entity: PropertywareEntity, cursor: Date) {
    this.cursors.set(`${organizationId}:${entity}`, cursor);
  }
  async upsertRecord(organizationId: string, record: NormalizedPropertywareRecord, seenAt: Date) {
    record = propertywareDatabaseUpsertSchema.parse(record) as NormalizedPropertywareRecord;
    const key = `${organizationId}:${record.entityType}:${record.externalId}`;
    const hash = stableSourceHash(record);
    const existing = this.records.get(key);
    if (!existing) {
      this.records.set(key, {
        record,
        sourceHash: hash,
        firstSyncedAt: seenAt,
        lastSyncedAt: seenAt,
        lastSeenAt: seenAt,
        deactivatedAt: record.isActive ? undefined : seenAt,
      });
      return 'created' as const;
    }
    const reactivated = !existing.record.isActive && record.isActive;
    const changed = existing.sourceHash !== hash || existing.record.isActive !== record.isActive;
    existing.record = record;
    existing.sourceHash = hash;
    existing.lastSeenAt = seenAt;
    existing.lastSyncedAt = seenAt;
    existing.deactivatedAt = record.isActive ? undefined : (existing.deactivatedAt ?? seenAt);
    return reactivated ? 'reactivated' : changed ? 'updated' : 'unchanged';
  }
  async touchRecords() {
    // In-memory records are already touched by upsertRecord.
  }
  async deactivateUnseen(
    organizationId: string,
    entity: PropertywareEntity,
    externalIds: Set<string>,
    seenAt: Date,
  ) {
    let count = 0;
    for (const [key, item] of this.records) {
      if (
        !key.startsWith(`${organizationId}:${entity}:`) ||
        externalIds.has(item.record.externalId) ||
        !item.record.isActive
      )
        continue;
      item.record = {
        ...item.record,
        isActive: false,
        sourceStatus: 'Inactive',
      } as NormalizedPropertywareRecord;
      item.sourceHash = stableSourceHash(item.record);
      item.deactivatedAt = seenAt;
      item.lastSyncedAt = seenAt;
      count += 1;
    }
    return count;
  }
  async addError(input: {
    runId: string;
    entity: PropertywareEntity;
    externalId?: string;
    pageOffset?: number;
    code: string;
    message: string;
    retryable: boolean;
    fingerprint?: string;
  }) {
    this.errors.push({ id: randomUUID(), ...input, createdAt: new Date() });
  }
  async listActive(
    entity: PropertywareEntity,
    organizationId: string,
    filters: Record<string, string | undefined> = {},
  ) {
    return [...this.records.entries()]
      .filter(
        ([key, item]) => key.startsWith(`${organizationId}:${entity}:`) && item.record.isActive,
      )
      .map(([, item]) => item.record)
      .filter((record) => {
        const active = (type: PropertywareEntity, externalId: string) =>
          this.records.get(`${organizationId}:${type}:${externalId}`)?.record.isActive === true;
        if (record.entityType === 'buildings' && !active('portfolios', record.portfolioExternalId))
          return false;
        if (
          record.entityType === 'units' &&
          (!active('portfolios', record.portfolioExternalId) ||
            !active('buildings', record.buildingExternalId))
        )
          return false;
        if (
          record.entityType === 'leases' &&
          (!active('portfolios', record.portfolioExternalId) ||
            !active('buildings', record.buildingExternalId) ||
            !active('units', record.unitExternalId))
        )
          return false;
        if (
          record.entityType === 'buildings' &&
          filters.portfolioId &&
          record.portfolioExternalId !== filters.portfolioId
        )
          return false;
        if (
          record.entityType === 'units' &&
          filters.propertyId &&
          record.buildingExternalId !== filters.propertyId
        )
          return false;
        if (
          record.entityType === 'leases' &&
          filters.unitId &&
          record.unitExternalId !== filters.unitId
        )
          return false;
        return true;
      })
      .map((record) => ({ ...record, id: record.externalId }));
  }
  async listActivePage(
    entity: PropertywareEntity,
    organizationId: string,
    query: {
      page: number;
      pageSize: number;
      portfolioId?: string;
      propertyId?: string;
      unitId?: string;
      status?: string;
      search?: string;
    },
  ) {
    const search = query.search?.trim().toLocaleLowerCase();
    const records = (
      await this.listActive(entity, organizationId, {
        portfolioId: query.portfolioId,
        propertyId: query.propertyId,
        unitId: query.unitId,
        status: query.status,
      })
    ).filter((record) => {
      if (!search) return true;
      const item = record as Record<string, unknown>;
      return [item.name, item.addressLine1, item.city]
        .filter((value): value is string => typeof value === 'string')
        .some((value) => value.toLocaleLowerCase().includes(search));
    });
    const start = (query.page - 1) * query.pageSize;
    const items = records
      .slice(start, start + query.pageSize)
      .map((record) => this.catalogItem(entity, record));
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: records.length,
      totalPages: Math.ceil(records.length / query.pageSize),
    };
  }
  async getActive(entity: PropertywareEntity, organizationId: string, externalId: string) {
    const records = await this.listActive(entity, organizationId);
    const item = records.find((record) => {
      const candidate = record as { id?: string; externalId?: string };
      return candidate.id === externalId || candidate.externalId === externalId;
    });
    return item ? this.catalogItem(entity, item) : null;
  }
  async status(organizationId: string) {
    const runs = (await this.listRuns(organizationId)) as StoredSyncRun[];
    return {
      provider: 'mock',
      lastRun: runs[0] ? this.runItem(runs[0], false) : null,
      cursors: [...this.cursors.entries()]
        .filter(([key]) => key.startsWith(`${organizationId}:`))
        .map(([entityType, cursor]) => ({ entityType: entityType.split(':').at(-1), cursor })),
      unresolvedErrors: this.errors.length,
    };
  }
  async verifyPopulation(organizationId: string): Promise<PropertywarePopulationVerification> {
    const entities: PropertywareEntity[] = ['portfolios', 'buildings', 'units', 'leases'];
    const counts = Object.fromEntries(
      entities.map((entity) => {
        const matching = [...this.records.entries()]
          .filter(([key]) => key.startsWith(`${organizationId}:${entity}:`))
          .map(([, item]) => item.record);
        const active = matching.filter((record) => record.isActive).length;
        return [entity, { total: matching.length, active, inactive: matching.length - active }];
      }),
    ) as PropertywarePopulationVerification['counts'];
    return populationVerification(organizationId, counts);
  }
  private catalogItem(entity: PropertywareEntity, record: unknown) {
    const item = record as Record<string, unknown>;
    const common = {
      id: item.id,
      externalId: item.externalId,
      sourceStatus: item.sourceStatus,
      isActive: item.isActive,
    };
    if (entity === 'portfolios')
      return { ...common, name: item.name, abbreviation: item.abbreviation };
    if (entity === 'buildings')
      return {
        ...common,
        portfolioId: item.portfolioExternalId,
        name: item.name,
        propertyType: item.propertyType,
        addressLine1: item.addressLine1,
        addressLine2: item.addressLine2,
        city: item.city,
        state: item.state,
        postalCode: item.postalCode,
      };
    if (entity === 'units')
      return {
        ...common,
        buildingId: item.buildingExternalId,
        name: item.name,
        type: item.type,
        vacant: item.vacant,
        bedrooms: item.bedrooms,
        bathrooms: item.bathrooms,
        addressLine1: item.addressLine1,
        city: item.city,
        state: item.state,
        postalCode: item.postalCode,
      };
    return {
      ...common,
      unitId: item.unitExternalId,
      leaseName: item.leaseName,
      startDate: item.startDate,
      endDate: item.endDate,
      scheduledMoveOutDate: item.scheduledMoveOutDate,
    };
  }
  private runItem(run: StoredSyncRun, includeOrganization: boolean) {
    const entities = (run as StoredSyncRun & { entities?: Record<string, unknown> }).entities;
    return {
      id: run.id,
      ...(includeOrganization ? { organizationId: run.organizationId } : {}),
      syncType: run.syncType,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      recordsFetched: run.recordsFetched,
      recordsCreated: run.recordsCreated,
      recordsUpdated: run.recordsUpdated,
      recordsUnchanged: run.recordsUnchanged,
      recordsDeactivated: run.recordsDeactivated,
      recordsReactivated: run.recordsReactivated,
      recordsFailed: run.recordsFailed,
      pagesFetched: run.pagesFetched,
      warnings: run.warnings,
      errorSummary: run.errorSummary,
      createdAt: run.createdAt,
      entities: entities ? Object.values(entities) : undefined,
    };
  }
}

const date = (input?: string) => (input ? new Date(input) : null);

@Injectable()
export class PrismaPropertywareSyncStore implements PropertywareSyncStore {
  private readonly recordCaches = new Map<
    string,
    Promise<Map<string, { id: string; sourceHash: string; isActive: boolean }>>
  >();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async acquireLock(lockKey: string, ownerId: string) {
    const now = new Date();
    await this.prisma.propertywareSyncLock.deleteMany({
      where: { lockKey, expiresAt: { lte: now } },
    });
    try {
      await this.prisma.propertywareSyncLock.create({
        data: { lockKey, ownerId, expiresAt: new Date(now.getTime() + 30 * 60_000) },
      });
      return true;
    } catch {
      return false;
    }
  }
  async releaseLock(lockKey: string, ownerId: string) {
    await this.prisma.propertywareSyncLock.deleteMany({ where: { lockKey, ownerId } });
  }
  async createRun(organizationId: string, mode: SyncMode, requestedBy: string) {
    const run = await this.prisma.propertywareSyncRun.create({
      data: { organizationId, syncType: mode, requestedBy, status: 'PENDING' },
    });
    return run as StoredSyncRun;
  }
  async updateRun(
    runId: string,
    status: SyncRunStatus,
    metrics: SyncMetrics,
    errorSummary?: string,
  ) {
    await this.prisma.propertywareSyncRun.update({
      where: { id: runId },
      data: {
        status,
        ...metrics,
        errorSummary,
        startedAt: status === 'RUNNING' ? new Date() : undefined,
        completedAt: ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'].includes(status)
          ? new Date()
          : undefined,
      },
    });
  }
  async updateEntityRun(
    runId: string,
    entity: PropertywareEntity,
    status: 'RUNNING' | 'COMPLETED' | 'FAILED',
    metrics: SyncMetrics,
  ) {
    await this.prisma.propertywareSyncRunEntity.upsert({
      where: { syncRunId_entityType: { syncRunId: runId, entityType: entity } },
      create: {
        syncRunId: runId,
        entityType: entity,
        status,
        ...metrics,
        completedAt: status === 'RUNNING' ? undefined : new Date(),
      },
      update: {
        status,
        ...metrics,
        completedAt: status === 'RUNNING' ? undefined : new Date(),
      },
    });
  }
  async getRun(runId: string) {
    return this.prisma.propertywareSyncRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        organizationId: true,
        syncType: true,
        status: true,
        startedAt: true,
        completedAt: true,
        recordsFetched: true,
        recordsCreated: true,
        recordsUpdated: true,
        recordsUnchanged: true,
        recordsDeactivated: true,
        recordsReactivated: true,
        recordsFailed: true,
        pagesFetched: true,
        warnings: true,
        entities: {
          select: {
            id: true,
            entityType: true,
            status: true,
            recordsFetched: true,
            recordsCreated: true,
            recordsUpdated: true,
            recordsFailed: true,
            warnings: true,
          },
        },
      },
    });
  }
  async listRuns(organizationId: string) {
    return this.prisma.propertywareSyncRun.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        organizationId: true,
        syncType: true,
        status: true,
        startedAt: true,
        completedAt: true,
        recordsFetched: true,
        recordsCreated: true,
        recordsUpdated: true,
        recordsUnchanged: true,
        recordsDeactivated: true,
        recordsReactivated: true,
        recordsFailed: true,
        pagesFetched: true,
        warnings: true,
        createdAt: true,
      },
    });
  }
  async listRunsPage(
    organizationId: string,
    query: {
      page: number;
      pageSize: number;
      status?: string;
      syncType?: string;
      from?: string;
      to?: string;
    },
  ) {
    const where = {
      organizationId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.syncType ? { syncType: query.syncType } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              gte: query.from ? new Date(query.from) : undefined,
              lte: query.to ? new Date(query.to) : undefined,
            },
          }
        : {}),
    } satisfies Prisma.PropertywareSyncRunWhereInput;
    const [items, total] = await Promise.all([
      this.prisma.propertywareSyncRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
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
      this.prisma.propertywareSyncRun.count({ where }),
    ]);
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }
  async listErrorsPage(
    organizationId: string,
    runId: string,
    query: { page: number; pageSize: number; entityType?: PropertywareEntity; resolved?: string },
  ) {
    const where = {
      syncRunId: runId,
      syncRun: { organizationId },
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.resolved === undefined
        ? {}
        : query.resolved === 'true'
          ? { resolvedAt: { not: null } }
          : { resolvedAt: null }),
    } satisfies Prisma.PropertywareSyncErrorWhereInput;
    const [items, total] = await Promise.all([
      this.prisma.propertywareSyncError.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          entityType: true,
          errorCode: true,
          sanitizedMessage: true,
          retryable: true,
          createdAt: true,
          resolvedAt: true,
        },
      }),
      this.prisma.propertywareSyncError.count({ where }),
    ]);
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }
  async getCursor(organizationId: string, entity: PropertywareEntity) {
    return (
      (
        await this.prisma.propertywareSyncCursor.findUnique({
          where: { organizationId_entityType: { organizationId, entityType: entity } },
        })
      )?.lastSuccessfulCursor ?? undefined
    );
  }
  async saveCursor(
    organizationId: string,
    entity: PropertywareEntity,
    cursor: Date,
    reconciliation: boolean,
  ) {
    await this.prisma.propertywareSyncCursor.upsert({
      where: { organizationId_entityType: { organizationId, entityType: entity } },
      create: {
        organizationId,
        entityType: entity,
        lastSuccessfulCursor: cursor,
        lastAttemptedCursor: cursor,
        lastSuccessfulSyncAt: new Date(),
        lastFullReconciliationAt: reconciliation ? new Date() : undefined,
      },
      update: {
        lastSuccessfulCursor: cursor,
        lastAttemptedCursor: cursor,
        lastSuccessfulSyncAt: new Date(),
        lastFullReconciliationAt: reconciliation ? new Date() : undefined,
      },
    });
  }
  async upsertRecord(
    organizationId: string,
    record: NormalizedPropertywareRecord,
    seenAt: Date,
  ): Promise<UpsertOutcome> {
    record = propertywareDatabaseUpsertSchema.parse(record) as NormalizedPropertywareRecord;
    const sourceHash = stableSourceHash(record);
    const key = {
      organizationId_sourceSystem_externalId: {
        organizationId,
        sourceSystem: PROPERTYWARE_SOURCE_SYSTEM,
        externalId: record.externalId,
      },
    };
    const common = {
      sourceStatus: record.sourceStatus,
      isActive: record.isActive,
      sourceCreatedAt: date(record.sourceCreatedAt),
      sourceUpdatedAt: date(record.sourceUpdatedAt),
      lastSyncedAt: seenAt,
      lastSeenAt: seenAt,
      deactivatedAt: record.isActive ? null : seenAt,
      sourceHash,
    };
    const cache = await this.getRecordCache(organizationId, record.entityType);
    const existing = cache.get(record.externalId);
    const outcome: UpsertOutcome = !existing
      ? 'created'
      : !existing.isActive && record.isActive
        ? 'reactivated'
        : existing.sourceHash === sourceHash && existing.isActive === record.isActive
          ? 'unchanged'
          : 'updated';
    if (outcome === 'unchanged') {
      return outcome;
    }
    let saved: { id: string };
    if (record.entityType === 'portfolios') {
      const portfolio = await this.prisma.propertywarePortfolio.upsert({
        where: key,
        create: {
          organizationId,
          externalId: record.externalId,
          name: record.name,
          abbreviation: record.abbreviation,
          ...common,
        },
        update: { name: record.name, abbreviation: record.abbreviation, ...common },
      });
      for (const owner of record.owners) {
        const saved = await this.prisma.propertywareOwner.upsert({
          where: {
            organizationId_sourceSystem_externalId: {
              organizationId,
              sourceSystem: PROPERTYWARE_SOURCE_SYSTEM,
              externalId: owner.externalId,
            },
          },
          create: {
            organizationId,
            externalId: owner.externalId,
            displayName: owner.displayName,
            isActive: owner.isActive,
            sourceStatus: owner.isActive ? 'Active' : 'Inactive',
          },
          update: {
            displayName: owner.displayName,
            isActive: owner.isActive,
            lastSeenAt: seenAt,
            lastSyncedAt: seenAt,
          },
        });
        await this.prisma.propertywarePortfolioOwner.upsert({
          where: { portfolioId_ownerId: { portfolioId: portfolio.id, ownerId: saved.id } },
          create: {
            portfolioId: portfolio.id,
            ownerId: saved.id,
            percentageOwnership: owner.percentageOwnership,
          },
          update: { percentageOwnership: owner.percentageOwnership },
        });
      }
      saved = portfolio;
    } else if (record.entityType === 'buildings') {
      const portfolio = await this.requirePortfolio(organizationId, record.portfolioExternalId);
      const data = {
        organizationId,
        externalId: record.externalId,
        portfolioId: portfolio.id,
        externalPortfolioId: record.portfolioExternalId,
        idNumber: record.idNumber,
        name: record.name,
        abbreviation: record.abbreviation,
        propertyType: record.propertyType,
        addressLine1: record.addressLine1,
        addressLine2: record.addressLine2,
        city: record.city,
        state: record.state,
        postalCode: record.postalCode,
        country: record.country,
        ...common,
      };
      saved = await this.prisma.propertywareBuilding.upsert({
        where: key,
        create: data,
        update: data,
      });
    } else if (record.entityType === 'units') {
      const portfolio = await this.requirePortfolio(organizationId, record.portfolioExternalId);
      const building = await this.requireBuilding(organizationId, record.buildingExternalId);
      const data = {
        organizationId,
        externalId: record.externalId,
        portfolioId: portfolio.id,
        buildingId: building.id,
        externalPortfolioId: record.portfolioExternalId,
        externalBuildingId: record.buildingExternalId,
        idNumber: record.idNumber,
        name: record.name,
        abbreviation: record.abbreviation,
        type: record.type,
        vacant: record.vacant,
        publishedForRent: record.publishedForRent,
        bedrooms: record.bedrooms,
        bathrooms: record.bathrooms,
        addressLine1: record.addressLine1,
        addressLine2: record.addressLine2,
        city: record.city,
        state: record.state,
        postalCode: record.postalCode,
        country: record.country,
        ...common,
      };
      saved = await this.prisma.propertywareUnit.upsert({ where: key, create: data, update: data });
    } else {
      const portfolio = await this.requirePortfolio(organizationId, record.portfolioExternalId);
      const building = await this.requireBuilding(organizationId, record.buildingExternalId);
      const unit = await this.requireUnit(organizationId, record.unitExternalId);
      const data = {
        organizationId,
        externalId: record.externalId,
        portfolioId: portfolio.id,
        buildingId: building.id,
        unitId: unit.id,
        externalPortfolioId: record.portfolioExternalId,
        externalBuildingId: record.buildingExternalId,
        externalUnitId: record.unitExternalId,
        idNumber: record.idNumber,
        leaseName: record.leaseName,
        startDate: date(record.startDate),
        endDate: date(record.endDate),
        moveInDate: date(record.moveInDate),
        scheduledMoveOutDate: date(record.scheduledMoveOutDate),
        moveOutDate: date(record.moveOutDate),
        noticeGivenDate: date(record.noticeGivenDate),
        reasonForLeaving: record.reasonForLeaving,
        tenantDisplayNames: record.tenantDisplayNames,
        ...common,
      };
      saved = await this.prisma.propertywareLease.upsert({
        where: key,
        create: data,
        update: data,
      });
    }
    cache.set(record.externalId, { id: saved.id, sourceHash, isActive: record.isActive });
    return outcome;
  }
  async touchRecords(
    organizationId: string,
    entity: PropertywareEntity,
    externalIds: string[],
    seenAt: Date,
  ) {
    if (externalIds.length === 0) return;
    await (this.delegateFor(entity) as any).updateMany({
      where: {
        organizationId,
        sourceSystem: PROPERTYWARE_SOURCE_SYSTEM,
        externalId: { in: externalIds },
      },
      data: { lastSeenAt: seenAt, lastSyncedAt: seenAt },
    });
  }
  async deactivateUnseen(
    organizationId: string,
    entity: PropertywareEntity,
    externalIds: Set<string>,
    seenAt: Date,
  ) {
    const where = { organizationId, isActive: true, externalId: { notIn: [...externalIds] } };
    const data = {
      isActive: false,
      sourceStatus: 'Inactive',
      deactivatedAt: seenAt,
      lastSyncedAt: seenAt,
    };
    const delegate = this.delegateFor(entity);
    return ((await (delegate as any).updateMany({ where, data })) as { count: number }).count;
  }
  async addError(input: {
    runId: string;
    entity: PropertywareEntity;
    externalId?: string;
    pageOffset?: number;
    code: string;
    message: string;
    retryable: boolean;
    fingerprint?: string;
  }) {
    await this.prisma.propertywareSyncError.create({
      data: {
        syncRunId: input.runId,
        entityType: input.entity,
        externalId: input.externalId,
        pageOffset: input.pageOffset,
        errorCode: input.code,
        sanitizedMessage: input.message,
        retryable: input.retryable,
        payloadFingerprint: input.fingerprint,
      },
    });
  }
  async listActive(
    entity: PropertywareEntity,
    organizationId: string,
    filters: Record<string, string | undefined> = {},
  ) {
    if (entity === 'portfolios')
      return this.prisma.propertywarePortfolio.findMany({
        where: { organizationId, isActive: true },
        orderBy: { name: 'asc' },
      });
    if (entity === 'buildings')
      return this.prisma.propertywareBuilding.findMany({
        where: {
          organizationId,
          isActive: true,
          portfolio: { isActive: true },
          externalPortfolioId: filters.portfolioId,
        },
        orderBy: { name: 'asc' },
      });
    if (entity === 'units')
      return this.prisma.propertywareUnit.findMany({
        where: {
          organizationId,
          isActive: true,
          building: { isActive: true, portfolio: { isActive: true } },
          externalBuildingId: filters.propertyId,
        },
        orderBy: { name: 'asc' },
      });
    return this.prisma.propertywareLease.findMany({
      where: {
        organizationId,
        isActive: true,
        unit: { isActive: true, building: { isActive: true, portfolio: { isActive: true } } },
        externalUnitId: filters.unitId,
        sourceStatus: filters.status,
      },
      orderBy: { scheduledMoveOutDate: 'asc' },
    });
  }
  async listActivePage(
    entity: PropertywareEntity,
    organizationId: string,
    query: {
      page: number;
      pageSize: number;
      portfolioId?: string;
      propertyId?: string;
      unitId?: string;
      status?: string;
      search?: string;
    },
  ) {
    const skip = (query.page - 1) * query.pageSize;
    if (entity === 'portfolios') {
      const where = {
        organizationId,
        isActive: true,
        ...(query.search
          ? { name: { contains: query.search.trim(), mode: 'insensitive' as const } }
          : {}),
      };
      const [items, total] = await Promise.all([
        this.prisma.propertywarePortfolio.findMany({
          where,
          orderBy: { name: 'asc' },
          skip,
          take: query.pageSize,
          select: {
            id: true,
            externalId: true,
            name: true,
            abbreviation: true,
            sourceStatus: true,
            isActive: true,
            lastSyncedAt: true,
          },
        }),
        this.prisma.propertywarePortfolio.count({ where }),
      ]);
      return this.page(items, total, query);
    }
    if (entity === 'buildings') {
      const search = query.search?.trim();
      const where = {
        organizationId,
        isActive: true,
        portfolio: { isActive: true },
        ...(query.portfolioId ? { externalPortfolioId: query.portfolioId } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { addressLine1: { contains: search, mode: 'insensitive' as const } },
                { city: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        this.prisma.propertywareBuilding.findMany({
          where,
          orderBy: { name: 'asc' },
          skip,
          take: query.pageSize,
          select: {
            id: true,
            externalId: true,
            portfolioId: true,
            name: true,
            propertyType: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            state: true,
            postalCode: true,
            sourceStatus: true,
            isActive: true,
            lastSyncedAt: true,
          },
        }),
        this.prisma.propertywareBuilding.count({ where }),
      ]);
      return this.page(items, total, query);
    }
    if (entity === 'units') {
      const where = {
        organizationId,
        isActive: true,
        building: { isActive: true, portfolio: { isActive: true } },
        ...(query.propertyId ? { externalBuildingId: query.propertyId } : {}),
      };
      const [items, total] = await Promise.all([
        this.prisma.propertywareUnit.findMany({
          where,
          orderBy: { name: 'asc' },
          skip,
          take: query.pageSize,
          select: {
            id: true,
            externalId: true,
            buildingId: true,
            name: true,
            type: true,
            vacant: true,
            bedrooms: true,
            bathrooms: true,
            addressLine1: true,
            city: true,
            state: true,
            postalCode: true,
            sourceStatus: true,
            isActive: true,
            lastSyncedAt: true,
          },
        }),
        this.prisma.propertywareUnit.count({ where }),
      ]);
      return this.page(items, total, query);
    }
    const where = {
      organizationId,
      isActive: true,
      unit: { isActive: true, building: { isActive: true, portfolio: { isActive: true } } },
      ...(query.unitId ? { externalUnitId: query.unitId } : {}),
      ...(query.status ? { sourceStatus: query.status } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.propertywareLease.findMany({
        where,
        orderBy: { scheduledMoveOutDate: 'asc' },
        skip,
        take: query.pageSize,
        select: {
          id: true,
          externalId: true,
          unitId: true,
          leaseName: true,
          sourceStatus: true,
          isActive: true,
          startDate: true,
          endDate: true,
          scheduledMoveOutDate: true,
          lastSyncedAt: true,
        },
      }),
      this.prisma.propertywareLease.count({ where }),
    ]);
    return this.page(items, total, query);
  }
  async getActive(entity: PropertywareEntity, organizationId: string, externalId: string) {
    const identity = { organizationId, isActive: true, OR: [{ id: externalId }, { externalId }] };
    if (entity === 'portfolios')
      return this.prisma.propertywarePortfolio.findFirst({
        where: identity,
        select: {
          id: true,
          externalId: true,
          name: true,
          abbreviation: true,
          sourceStatus: true,
          isActive: true,
          lastSyncedAt: true,
        },
      });
    if (entity === 'buildings')
      return this.prisma.propertywareBuilding.findFirst({
        where: { ...identity, portfolio: { isActive: true } },
        select: {
          id: true,
          externalId: true,
          portfolioId: true,
          name: true,
          propertyType: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          state: true,
          postalCode: true,
          sourceStatus: true,
          isActive: true,
          lastSyncedAt: true,
        },
      });
    if (entity === 'units')
      return this.prisma.propertywareUnit.findFirst({
        where: { ...identity, building: { isActive: true, portfolio: { isActive: true } } },
        select: {
          id: true,
          externalId: true,
          buildingId: true,
          name: true,
          type: true,
          vacant: true,
          bedrooms: true,
          bathrooms: true,
          addressLine1: true,
          city: true,
          state: true,
          postalCode: true,
          sourceStatus: true,
          isActive: true,
          lastSyncedAt: true,
        },
      });
    return this.prisma.propertywareLease.findFirst({
      where: {
        ...identity,
        unit: { isActive: true, building: { isActive: true, portfolio: { isActive: true } } },
      },
      select: {
        id: true,
        externalId: true,
        unitId: true,
        leaseName: true,
        sourceStatus: true,
        isActive: true,
        startDate: true,
        endDate: true,
        scheduledMoveOutDate: true,
        lastSyncedAt: true,
      },
    });
  }
  async status(organizationId: string) {
    const [lastRun, cursors, unresolvedErrors] = await Promise.all([
      this.prisma.propertywareSyncRun.findFirst({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          syncType: true,
          status: true,
          startedAt: true,
          completedAt: true,
          recordsFetched: true,
          recordsCreated: true,
          recordsUpdated: true,
          recordsFailed: true,
          warnings: true,
        },
      }),
      this.prisma.propertywareSyncCursor.findMany({
        where: { organizationId },
        select: {
          entityType: true,
          lastSuccessfulCursor: true,
          lastSuccessfulSyncAt: true,
          lastFullReconciliationAt: true,
        },
      }),
      this.prisma.propertywareSyncError.count({
        where: { syncRun: { organizationId }, resolvedAt: null },
      }),
    ]);
    return { provider: 'live', lastRun, cursors, unresolvedErrors };
  }
  async verifyPopulation(organizationId: string): Promise<PropertywarePopulationVerification> {
    const [portfolios, buildings, units, leases] = await Promise.all([
      this.countPopulation(this.prisma.propertywarePortfolio, organizationId),
      this.countPopulation(this.prisma.propertywareBuilding, organizationId),
      this.countPopulation(this.prisma.propertywareUnit, organizationId),
      this.countPopulation(this.prisma.propertywareLease, organizationId),
    ]);
    return populationVerification(organizationId, { portfolios, buildings, units, leases });
  }
  private async countPopulation(delegate: any, organizationId: string) {
    const [total, active] = await Promise.all([
      delegate.count({ where: { organizationId } }),
      delegate.count({ where: { organizationId, isActive: true } }),
    ]);
    return { total, active, inactive: total - active };
  }
  private page<T>(items: T[], total: number, query: { page: number; pageSize: number }) {
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }
  private async requirePortfolio(organizationId: string, externalId: string) {
    const item = (await this.getRecordCache(organizationId, 'portfolios')).get(externalId);
    if (!item) throw new Error(`Missing synchronized portfolio parent ${externalId}.`);
    return item;
  }
  private async requireBuilding(organizationId: string, externalId: string) {
    const item = (await this.getRecordCache(organizationId, 'buildings')).get(externalId);
    if (!item) throw new Error(`Missing synchronized building parent ${externalId}.`);
    return item;
  }
  private async requireUnit(organizationId: string, externalId: string) {
    const item = (await this.getRecordCache(organizationId, 'units')).get(externalId);
    if (!item) throw new Error(`Missing synchronized unit parent ${externalId}.`);
    return item;
  }
  private delegateFor(entity: PropertywareEntity) {
    return entity === 'portfolios'
      ? this.prisma.propertywarePortfolio
      : entity === 'buildings'
        ? this.prisma.propertywareBuilding
        : entity === 'units'
          ? this.prisma.propertywareUnit
          : this.prisma.propertywareLease;
  }
  private getRecordCache(
    organizationId: string,
    entity: PropertywareEntity,
  ): Promise<Map<string, { id: string; sourceHash: string; isActive: boolean }>> {
    const cacheKey = `${organizationId}:${entity}`;
    const existingCache = this.recordCaches.get(cacheKey);
    if (existingCache) return existingCache;
    const cache = (this.delegateFor(entity) as any)
      .findMany({
        where: { organizationId, sourceSystem: PROPERTYWARE_SOURCE_SYSTEM },
        select: { id: true, externalId: true, sourceHash: true, isActive: true },
      })
      .then(
        (
          records: Array<{
            id: string;
            externalId: string;
            sourceHash: string;
            isActive: boolean;
          }>,
        ) =>
          new Map(
            records.map((record) => [
              record.externalId,
              { id: record.id, sourceHash: record.sourceHash, isActive: record.isActive },
            ]),
          ),
      );
    this.recordCaches.set(cacheKey, cache);
    return cache;
  }
}

export const PROPERTYWARE_SYNC_STORE = Symbol('PROPERTYWARE_SYNC_STORE');

function populationVerification(
  organizationId: string,
  counts: PropertywarePopulationVerification['counts'],
): PropertywarePopulationVerification {
  const values = Object.values(counts);
  return {
    organizationId,
    verifiedAt: new Date().toISOString(),
    counts,
    total: values.reduce((sum, item) => sum + item.total, 0),
    active: values.reduce((sum, item) => sum + item.active, 0),
    inactive: values.reduce((sum, item) => sum + item.inactive, 0),
  };
}
