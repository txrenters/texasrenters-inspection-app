import { Inject, Injectable } from '@nestjs/common';

import type { PropertywareEntity } from '../../integrations/propertyware/propertyware.constants';
import type { SyncMode } from '../../integrations/propertyware/propertyware.types';
import { PropertywareSyncWorker } from './propertyware-sync.worker';

export interface EnqueuePropertywareSync {
  organizationId: string;
  requestedBy: string;
  entities: PropertywareEntity[];
  mode: SyncMode;
}

@Injectable()
export class PropertywareSyncCoordinator {
  constructor(@Inject(PropertywareSyncWorker) private readonly worker: PropertywareSyncWorker) {}

  async enqueue(input: EnqueuePropertywareSync) {
    const request = { entities: input.entities, mode: input.mode, requestedBy: input.requestedBy };
    const run = await this.worker.createRun(input.organizationId, request);
    setImmediate(() => void this.worker.execute(run.id, input.organizationId, request));
    return { syncRunId: run.id, status: 'PENDING' as const };
  }
}
