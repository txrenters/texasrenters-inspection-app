import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  PROPERTYWARE_ENTITY_ORDER,
  type PropertywareEntity,
} from '../../integrations/propertyware/propertyware.constants';
import { PROPERTYWARE_CONFIG } from '../../integrations/propertyware/propertyware.config';
import { PropertywareError } from '../../integrations/propertyware/propertyware.errors';
import {
  mapBuilding,
  mapLease,
  mapPortfolio,
  mapUnit,
} from '../../integrations/propertyware/propertyware.mapper';
import { propertywarePages } from '../../integrations/propertyware/propertyware.pagination';
import { propertywareSchemas } from '../../integrations/propertyware/propertyware.schemas';
import { normalizedPropertywareRecordSchema } from '../../integrations/propertyware/propertyware.schemas';
import { PropertywareService } from '../../integrations/propertyware/propertyware.service';
import type {
  NormalizedPropertywareRecord,
  PropertywareDryRunResult,
  PropertywareConfig,
  SyncMetrics,
  SyncRequest,
} from '../../integrations/propertyware/propertyware.types';
import { PROPERTYWARE_SYNC_STORE, type PropertywareSyncStore } from './propertyware-sync.store';
import { CacheInvalidationService } from '../../cache/cache-invalidation.service';

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

async function inBatches<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
) {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += concurrency)
    results.push(...(await Promise.all(items.slice(index, index + concurrency).map(operation))));
  return results;
}

@Injectable()
export class PropertywareSyncWorker {
  private readonly logger = new Logger(PropertywareSyncWorker.name);

  constructor(
    @Inject(PROPERTYWARE_CONFIG) private readonly config: PropertywareConfig,
    @Inject(PropertywareService) private readonly provider: PropertywareService,
    @Inject(PROPERTYWARE_SYNC_STORE) private readonly store: PropertywareSyncStore,
    @Optional()
    @Inject(CacheInvalidationService)
    private readonly cacheInvalidation?: CacheInvalidationService,
  ) {}

  async createRun(organizationId: string, request: SyncRequest) {
    return this.store.createRun(organizationId, request.mode, request.requestedBy);
  }

  async dryRun(
    entities: PropertywareEntity[],
    correlationId = randomUUID(),
  ): Promise<PropertywareDryRunResult> {
    const result: PropertywareDryRunResult = {
      mode: 'dry-run',
      provider: this.config.provider,
      entities: [],
      totals: { pagesFetched: 0, recordsFetched: 0, recordsMapped: 0, warnings: 0 },
    };
    for (const entity of PROPERTYWARE_ENTITY_ORDER.filter((item) => entities.includes(item))) {
      const summary = {
        entityType: entity,
        pagesFetched: 0,
        recordsFetched: 0,
        recordsMapped: 0,
        warnings: [] as string[],
      };
      for await (const page of propertywarePages(
        this.provider,
        entity,
        { limit: this.config.pageSize, includeDeactivated: false },
        correlationId,
      )) {
        summary.pagesFetched += 1;
        summary.recordsFetched += page.receivedCount ?? page.records.length;
        if (page.validationErrors?.length)
          summary.warnings.push(
            `${page.validationErrors.length} ${entity} record(s) failed schema validation and were skipped.`,
          );
        for (const raw of page.records) {
          this.map(entity, raw);
          summary.recordsMapped += 1;
        }
      }
      if (summary.recordsFetched === 0)
        summary.warnings.push(
          'ZERO_RECORDS_WARNING: verify account scope, permissions, filters, and organization ID.',
        );
      result.entities.push(summary);
      result.totals.pagesFetched += summary.pagesFetched;
      result.totals.recordsFetched += summary.recordsFetched;
      result.totals.recordsMapped += summary.recordsMapped;
      result.totals.warnings += summary.warnings.length;
    }
    return result;
  }

  async execute(runId: string, organizationId: string, request: SyncRequest) {
    const ownerId = randomUUID();
    const lockKey = `propertyware:${organizationId}`;
    const metrics = emptyMetrics();
    if (!(await this.store.acquireLock(lockKey, ownerId))) {
      await this.store.updateRun(
        runId,
        'CANCELLED',
        metrics,
        'Another Propertyware sync is running.',
      );
      return;
    }
    await this.store.updateRun(runId, 'RUNNING', metrics);
    const cursorEnd = new Date();
    this.logger.log({
      event: 'propertyware_sync_started',
      runId,
      mode: request.mode,
      entities: request.entities,
    });
    try {
      const ordered = PROPERTYWARE_ENTITY_ORDER.filter((entity) =>
        request.entities.includes(entity),
      );
      for (const entity of ordered) {
        try {
          await this.syncEntity(runId, organizationId, entity, request.mode, cursorEnd, metrics);
        } catch (error) {
          const providerError = error instanceof PropertywareError ? error : undefined;
          const message =
            providerError?.status === 403
              ? `Propertyware denied read access to ${entity}. Grant this API integration permission for the ${entity} list and detail endpoints.`
              : (providerError?.message ?? `Propertyware ${entity} synchronization failed.`);
          await this.store.addError({
            runId,
            entity,
            code: providerError?.code ?? 'PROPERTYWARE_SYNC_FAILED',
            message,
            retryable: providerError?.retryable ?? false,
          });
          if (providerError?.status === 403)
            throw new PropertywareError(
              message,
              providerError.code,
              providerError.status,
              providerError.retryable,
            );
          throw error;
        }
      }
      const status =
        metrics.recordsFailed > 0 || metrics.warnings > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
      await this.store.updateRun(runId, status, metrics);
      await this.cacheInvalidation?.publish({
        type: 'propertyware.sync.finished',
        organizationId,
        entities: ordered,
      });
      this.logger.log({ event: 'propertyware_sync_completed', runId, status, ...metrics });
    } catch (error) {
      const providerError = error instanceof PropertywareError ? error : undefined;
      await this.store.updateRun(
        runId,
        'FAILED',
        metrics,
        providerError?.message ?? 'Synchronization failed.',
      );
      await this.cacheInvalidation?.publish({
        type: 'propertyware.sync.finished',
        organizationId,
        entities: request.entities,
      });
      this.logger.error({
        event: 'propertyware_sync_failed',
        runId,
        code: providerError?.code ?? 'PROPERTYWARE_SYNC_FAILED',
      });
    } finally {
      await this.store.releaseLock(lockKey, ownerId);
    }
  }

  private async syncEntity(
    runId: string,
    organizationId: string,
    entity: PropertywareEntity,
    mode: SyncRequest['mode'],
    cursorEnd: Date,
    metrics: SyncMetrics,
  ) {
    const seen = new Set<string>();
    const entityMetrics = emptyMetrics();
    const add = (key: keyof SyncMetrics, amount = 1) => {
      metrics[key] += amount;
      entityMetrics[key] += amount;
    };
    await this.store.updateEntityRun(runId, entity, 'RUNNING', entityMetrics);
    const previousCursor = await this.store.getCursor(organizationId, entity);
    if (mode === 'incremental' && !previousCursor)
      throw new PropertywareError(
        `Propertyware ${entity} requires an initial sync before incremental sync.`,
        'PROPERTYWARE_INITIAL_SYNC_REQUIRED',
      );
    const cursorStart =
      mode === 'incremental' && previousCursor
        ? new Date(previousCursor.getTime() - this.config.cursorOverlapSeconds * 1000)
        : undefined;
    this.logger.log({
      event: 'propertyware_entity_started',
      runId,
      entity,
      mode,
      cursorStart,
    });
    try {
      for await (const page of propertywarePages(
        this.provider,
        entity,
        {
          limit: this.config.pageSize,
          lastModifiedDateTimeStart: cursorStart?.toISOString(),
          lastModifiedDateTimeEnd: cursorEnd.toISOString(),
          includeDeactivated: false,
        },
        runId,
      )) {
        add('pagesFetched');
        add('recordsFetched', page.receivedCount ?? page.records.length);
        for (const validationError of page.validationErrors ?? []) {
          // A record that fails schema validation is quarantined (skipped), not a
          // processing failure — count it as a warning and record the concrete
          // reason so it is diagnosable in the admin UI.
          add('warnings');
          await this.store.addError({
            runId,
            entity,
            externalId: validationError.externalId,
            pageOffset: page.offset + validationError.index,
            code: validationError.code,
            message: validationError.detail
              ? `Propertyware ${entity} record was quarantined — ${validationError.detail}.`
              : `Propertyware ${entity} record failed schema validation and was skipped.`,
            retryable: false,
          });
        }
        const outcomes: Array<{
          externalId: string;
          outcome: Awaited<ReturnType<PropertywareSyncStore['upsertRecord']>>;
        }> = [];
        for (let index = 0; index < page.records.length; index += this.config.databaseBatchSize) {
          const batch = page.records.slice(index, index + this.config.databaseBatchSize);
          const databaseStartedAt = performance.now();
          const batchOutcomes = await inBatches(
            batch,
            this.config.databaseConcurrency,
            async (raw) => {
              const record = this.map(entity, raw);
              const outcome = await this.store.upsertRecord(organizationId, record, cursorEnd);
              return { externalId: record.externalId, outcome };
            },
          );
          outcomes.push(...batchOutcomes);
          this.logger.debug({
            event: 'propertyware_database_batch_processed',
            runId,
            entity,
            records: batch.length,
            durationMs: Math.round((performance.now() - databaseStartedAt) * 10) / 10,
          });
        }
        for (const { externalId, outcome } of outcomes) {
          seen.add(externalId);
          if (outcome === 'created') add('recordsCreated');
          else if (outcome === 'updated') add('recordsUpdated');
          else if (outcome === 'reactivated') add('recordsReactivated');
          else add('recordsUnchanged');
        }
        await this.store.touchRecords(
          organizationId,
          entity,
          outcomes
            .filter(({ outcome }) => outcome === 'unchanged')
            .map(({ externalId }) => externalId),
          cursorEnd,
        );
        this.logger.debug({
          event: 'propertyware_page_processed',
          runId,
          entity,
          offset: page.offset,
          count: page.records.length,
        });
      }
      if (entityMetrics.recordsFetched === 0) {
        add('warnings');
        await this.store.addError({
          runId,
          entity,
          code: 'ZERO_RECORDS_WARNING',
          message:
            'Propertyware returned zero records; verify account scope, permissions, filters, and organization ID.',
          retryable: false,
        });
      }
      if (mode === 'reconciliation' && entity !== 'leases') {
        const sweep = await this.store.deactivateUnseen(organizationId, entity, seen, cursorEnd);
        add('recordsDeactivated', sweep.deactivated);

        // A refusal is the guard working, but it is still something nobody
        // asked for and nobody would otherwise see: the run would report zero
        // deactivations, which is exactly what a healthy run reports. Recorded
        // as an error so it reaches the sync log rather than only the metrics.
        if (sweep.refused) {
          add('warnings');
          await this.store.addError({
            runId,
            entity,
            code: `DEACTIVATION_REFUSED_${sweep.refused}`,
            message:
              sweep.refused === 'NOTHING_SEEN'
                ? `Propertyware returned no ${entity} at all, so every active record would have been deactivated. Refused; ${sweep.activeBefore ?? 0} left untouched. Check account scope, permissions and credentials.`
                : `Reconciliation would have deactivated ${sweep.wouldHave ?? 0} of ${sweep.activeBefore ?? 0} active ${entity} in one sweep, which is more than a plausible amount of churn. Refused; nothing was changed. Re-run once the fetch is known to be complete.`,
            retryable: false,
          });
          this.logger.warn({
            event: 'propertyware_deactivation_refused',
            runId,
            entity,
            reason: sweep.refused,
            wouldHave: sweep.wouldHave,
            activeBefore: sweep.activeBefore,
          });
        }
      }
      await this.store.saveCursor(organizationId, entity, cursorEnd, mode === 'reconciliation');
      await this.store.updateEntityRun(runId, entity, 'COMPLETED', entityMetrics);
    } catch (error) {
      add('recordsFailed');
      await this.store.updateEntityRun(runId, entity, 'FAILED', entityMetrics);
      throw error;
    }
  }

  private map(entity: PropertywareEntity, raw: unknown): NormalizedPropertywareRecord {
    const mapped =
      entity === 'portfolios'
        ? mapPortfolio(propertywareSchemas.portfolios.parse(raw))
        : entity === 'buildings'
          ? mapBuilding(propertywareSchemas.buildings.parse(raw))
          : entity === 'units'
            ? mapUnit(propertywareSchemas.units.parse(raw))
            : mapLease(propertywareSchemas.leases.parse(raw));
    return normalizedPropertywareRecordSchema.parse(mapped);
  }
}
