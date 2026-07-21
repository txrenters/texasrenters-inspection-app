import { Module } from '@nestjs/common';

import { PropertywareReconciliationWorker } from '../../workers/propertyware-sync/propertyware-reconciliation.worker';
import { PropertywareSyncCoordinator } from '../../workers/propertyware-sync/propertyware-sync.coordinator';
import {
  InMemoryPropertywareSyncStore,
  PrismaPropertywareSyncStore,
  PROPERTYWARE_SYNC_STORE,
} from '../../workers/propertyware-sync/propertyware-sync.store';
import { PropertywareSyncWorker } from '../../workers/propertyware-sync/propertyware-sync.worker';
import { ApiAuthGuard, RolesGuard } from '../../common/auth';
import { PropertywareClient } from './propertyware.client';
import { PROPERTYWARE_CONFIG, getPropertywareConfig } from './propertyware.config';
import {
  PropertywareCatalogController,
  PropertywareIntegrationController,
} from './propertyware.controller';
import { PropertywareService } from './propertyware.service';

@Module({
  controllers: [PropertywareIntegrationController, PropertywareCatalogController],
  providers: [
    { provide: PROPERTYWARE_CONFIG, useFactory: getPropertywareConfig },
    PropertywareClient,
    PropertywareService,
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
    ApiAuthGuard,
    RolesGuard,
  ],
  exports: [PROPERTYWARE_SYNC_STORE, PropertywareSyncCoordinator],
})
export class PropertywareModule {}
