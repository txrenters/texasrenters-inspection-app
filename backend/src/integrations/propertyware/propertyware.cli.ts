import { NestFactory } from '@nestjs/core';

import { AppModule } from '../../app.module';
import { withTenant } from '../../database/tenant-context';
import { PROPERTYWARE_ENTITIES, type PropertywareEntity } from './propertyware.constants';
import type { SyncRequest } from './propertyware.types';
import { PropertywareSyncWorker } from '../../workers/propertyware-sync/propertyware-sync.worker';
import {
  PROPERTYWARE_SYNC_STORE,
  type PropertywareSyncStore,
} from '../../workers/propertyware-sync/propertyware-sync.store';

async function main() {
  const action = process.argv[2] ?? 'status';
  const target = process.argv[3];
  const requestedEntities = process.argv[4]?.split(',').filter(Boolean);
  const entities = requestedEntities?.length
    ? requestedEntities.map((entity) => {
        if (!PROPERTYWARE_ENTITIES.includes(entity as PropertywareEntity))
          throw new Error(`Unsupported Propertyware entity: ${entity}.`);
        return entity as PropertywareEntity;
      })
    : [...PROPERTYWARE_ENTITIES];
  const provider = target === 'live' ? 'live' : 'mock';
  process.env.PROPERTYWARE_PROVIDER = provider;
  process.env.PROPERTYWARE_STORE =
    action === 'verify-db' || target === 'db' || provider === 'live'
      ? 'prisma'
      : (process.env.PROPERTYWARE_STORE ?? 'memory');
  const organizationId =
    process.env.PROPERTYWARE_LOCAL_ORGANIZATION_ID ?? '10000000-0000-4000-8000-000000000001';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    /**
     * Everything here runs inside the tenant, exactly as the scheduled path
     * does — `PropertywareSyncCoordinator` wraps its trigger in `withTenant`,
     * and this CLI reaches the same worker without going through it.
     *
     * Without this the RLS policies see no `app.organization_id` and fail
     * closed, which shows up in two very different ways. Writes error, so
     * `initial` died on `new row violates row-level security policy for table
     * "propertyware_sync_runs"`. Reads do not: they return nothing, so
     * `status` and `verify-db` would have cheerfully reported an empty catalog
     * rather than admitting they could not see it.
     */
    await withTenant(organizationId, async () => {
      const store = app.get<PropertywareSyncStore>(PROPERTYWARE_SYNC_STORE);
      if (action === 'verify-db') {
        process.stdout.write(
          `${JSON.stringify(await store.verifyPopulation(organizationId), null, 2)}\n`,
        );
        return;
      }
      if (action === 'status') {
        process.stdout.write(`${JSON.stringify(await store.status(organizationId), null, 2)}\n`);
        return;
      }
      const worker = app.get(PropertywareSyncWorker);
      if (action === 'dry-run') {
        process.stdout.write(`${JSON.stringify(await worker.dryRun(entities), null, 2)}\n`);
        return;
      }
      const mode =
        action === 'reconcile'
          ? 'reconciliation'
          : action === 'incremental'
            ? 'incremental'
            : 'initial';
      const request: SyncRequest = {
        entities,
        mode,
        requestedBy: 'local-cli',
      };
      const run = await worker.createRun(organizationId, request);
      await worker.execute(run.id, organizationId, request);
      const storedRun = await store.getRun(run.id);
      const verification =
        mode === 'initial' &&
        ['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(
          (storedRun as { status?: string } | null)?.status ?? '',
        )
          ? await store.verifyPopulation(organizationId)
          : undefined;
      process.stdout.write(`${JSON.stringify({ run: storedRun, verification }, null, 2)}\n`);
    });
  } finally {
    await app.close();
  }
}

void main();
