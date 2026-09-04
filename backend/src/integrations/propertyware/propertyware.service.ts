import { Inject, Injectable } from '@nestjs/common';

import type { PropertywareEntity } from './propertyware.constants';
import { PROPERTYWARE_CONFIG } from './propertyware.config';
import { PropertywareClient } from './propertyware.client';
import { mockPropertywareRecords } from './propertyware.fixtures';
import { propertywareSchemas } from './propertyware.schemas';
import type {
  PropertywareConfig,
  PropertywarePage,
  PropertywarePageQuery,
} from './propertyware.types';

export interface PropertywareProvider {
  fetchPage(
    entity: PropertywareEntity,
    query: PropertywarePageQuery,
    correlationId: string,
  ): Promise<PropertywarePage<unknown>>;
}

@Injectable()
export class PropertywareService implements PropertywareProvider {
  constructor(
    @Inject(PROPERTYWARE_CONFIG) private readonly config: PropertywareConfig,
    @Inject(PropertywareClient) private readonly client: PropertywareClient,
  ) {}

  /**
   * Hands the client a way to turn a building address into an external id.
   *
   * The lease report identifies its building by address, and the client has no
   * database of its own. Loaded once per run by the caller and passed down,
   * rather than queried per row.
   */
  useBuildingAddresses(index: { resolve(address: string, postalCode?: string): string | null }) {
    this.client.useBuildingAddresses(index);
  }

  async fetchPage(
    entity: PropertywareEntity,
    query: PropertywarePageQuery,
    correlationId: string,
  ): Promise<PropertywarePage<unknown>> {
    if (this.config.provider === 'live') return this.client.fetchPage(entity, query, correlationId);
    const offset = query.offset ?? 0;
    const limit = query.limit ?? this.config.pageSize;
    const records = [...mockPropertywareRecords[entity]]
      .filter((record) => {
        if (!query.includeDeactivated && 'active' in record && !record.active) return false;
        if (!query.lastModifiedDateTimeStart) return true;
        return (
          'lastModifiedDateTime' in record &&
          record.lastModifiedDateTime >= query.lastModifiedDateTimeStart
        );
      })
      .map((record) => propertywareSchemas[entity].parse(record));
    return {
      records: records.slice(offset, offset + limit),
      totalCount: records.length,
      offset,
      limit,
    };
  }
}
