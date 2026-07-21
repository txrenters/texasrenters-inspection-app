import { Inject, Injectable } from '@nestjs/common';

import type { PropertywareEntity } from '../../integrations/propertyware/propertyware.constants';
import { PropertywareSyncCoordinator } from './propertyware-sync.coordinator';

@Injectable()
export class PropertywareReconciliationWorker {
  constructor(
    @Inject(PropertywareSyncCoordinator) private readonly coordinator: PropertywareSyncCoordinator,
  ) {}

  enqueue(organizationId: string, requestedBy: string, entities: PropertywareEntity[]) {
    return this.coordinator.enqueue({
      organizationId,
      requestedBy,
      entities,
      mode: 'reconciliation',
    });
  }
}
