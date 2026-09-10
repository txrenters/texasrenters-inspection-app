import { Module } from '@nestjs/common';

import { AdminModule } from '../../admin/admin.module';

import { PropertywareReconciliationWorker } from '../../workers/propertyware-sync/propertyware-reconciliation.worker';
import { PropertywareSyncCoordinator } from '../../workers/propertyware-sync/propertyware-sync.coordinator';
import { PropertywareSyncScheduler } from '../../workers/propertyware-sync/propertyware-sync.scheduler';
import { PropertywareTenantScheduler } from '../../workers/propertyware-sync/propertyware-tenant.scheduler';
import { PropertywareTenantSyncService } from './propertyware.tenant-sync.service';
import { BuildingAddressResolver } from './propertyware.building-address-resolver';
import {
  InMemoryPropertywareSyncStore,
  PrismaPropertywareSyncStore,
  PROPERTYWARE_SYNC_STORE,
} from '../../workers/propertyware-sync/propertyware-sync.store';
import { PropertywareSyncWorker } from '../../workers/propertyware-sync/propertyware-sync.worker';
import { ApiAuthGuard, PermissionsGuard } from '../../common/auth';
import { PropertywareClient } from './propertyware.client';
import { PROPERTYWARE_CONFIG, getPropertywareConfig } from './propertyware.config';
import {
  PropertywareCatalogController,
  PropertywareIntegrationController,
} from './propertyware.controller';
import { PropertywareInspectionDocsService } from './propertyware.inspection-docs.service';
import { PropertywareService } from './propertyware.service';

@Module({
  // AdminModule for the importer only. The dependency runs one way -- nothing
  // in the admin chain imports Propertyware -- so this cannot become a cycle.
  imports: [AdminModule],
  controllers: [PropertywareIntegrationController, PropertywareCatalogController],
  providers: [
    { provide: PROPERTYWARE_CONFIG, useFactory: getPropertywareConfig },
    PropertywareClient,
    PropertywareService,
    PropertywareInspectionDocsService,
    InMemoryPropertywareSyncStore,
    PrismaPropertywareSyncStore,
    {
      provide: PROPERTYWARE_SYNC_STORE,
      useFactory: (
        config: ReturnType<typeof getPropertywareConfig>,
        memory: InMemoryPropertywareSyncStore,
        prisma: PrismaPropertywareSyncStore,
      ) => (config.store === 'prisma' ? prisma : memory),
      inject: [PROPERTYWARE_CONFIG, InMemoryPropertywareSyncStore, PrismaPropertywareSyncStore],
    },
    PropertywareSyncWorker,
    PropertywareSyncCoordinator,
    PropertywareReconciliationWorker,
    PropertywareSyncScheduler,
    PropertywareTenantScheduler,
    PropertywareTenantSyncService,
    BuildingAddressResolver,
    ApiAuthGuard,
    PermissionsGuard,
  ],
  exports: [PROPERTYWARE_SYNC_STORE, PropertywareSyncCoordinator, PropertywareInspectionDocsService],
})
export class PropertywareModule {}
