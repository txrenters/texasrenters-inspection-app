import type { PropertywareEntity } from '../integrations/propertyware/propertyware.constants';

export type CacheInvalidationEvent =
  | { type: 'inspection.changed'; organizationId: string }
  | { type: 'technician.changed'; organizationId: string; technicianId?: string }
  | {
      type: 'propertyware.sync.finished';
      organizationId: string;
      entities: PropertywareEntity[];
    };

export interface CacheInvalidationPublisher {
  publish(event: CacheInvalidationEvent): Promise<void>;
}
