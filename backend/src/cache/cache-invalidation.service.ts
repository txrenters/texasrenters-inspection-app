import { Inject, Injectable, Logger } from '@nestjs/common';

import type { CacheInvalidationEvent, CacheInvalidationPublisher } from './cache-events';
import { CacheService } from './cache.service';
import type { CacheResource } from './cache-policy';

const PROPERTYWARE_RESOURCES = {
  portfolios: ['portfolios'],
  buildings: ['properties', 'propertySearch', 'propertyDetails'],
  units: ['units', 'propertyDetails'],
  leases: ['leases', 'propertyDetails'],
} satisfies Record<string, CacheResource[]>;

@Injectable()
export class CacheInvalidationService implements CacheInvalidationPublisher {
  private readonly logger = new Logger(CacheInvalidationService.name);

  constructor(@Inject(CacheService) private readonly cache: CacheService) {}

  async publish(event: CacheInvalidationEvent) {
    const resources = new Set<CacheResource>();
    if (event.type === 'inspection.changed') {
      resources.add('dashboard');
      resources.add('properties');
      resources.add('propertySearch');
      resources.add('technicians');
    }
    if (event.type === 'technician.changed') {
      resources.add('technicians');
      resources.add('dashboard');
    }
    if (event.type === 'propertyware.sync.finished') {
      for (const entity of event.entities)
        for (const resource of PROPERTYWARE_RESOURCES[entity]) resources.add(resource);
      resources.add('dashboard');
      resources.add('propertywareStatus');
    }
    await Promise.all(
      [...resources].map((resource) => this.bumpWithRetry(resource, event.organizationId)),
    );
  }

  bump(resource: CacheResource, organizationId: string) {
    return this.bumpWithRetry(resource, organizationId);
  }

  invalidate(resource: CacheResource, organizationId: string, query: unknown) {
    return this.cache.invalidate(resource, organizationId, query);
  }

  private async bumpWithRetry(resource: CacheResource, scope: string) {
    if (await this.cache.bumpNamespace(resource, scope)) return;
    if (await this.cache.bumpNamespace(resource, scope)) return;
    this.logger.warn({ event: 'cache_invalidation_failed', resource });
  }
}
