import type { PropertywareEntity } from './propertyware.constants';
import type { PropertywareClient } from './propertyware.client';
import type { PropertywarePage, PropertywarePageQuery } from './propertyware.types';

interface PropertywarePageFetcher {
  fetchPage(
    entity: PropertywareEntity,
    query: PropertywarePageQuery,
    correlationId: string,
  ): Promise<PropertywarePage<unknown>>;
}

export async function* propertywarePages(
  client: PropertywarePageFetcher | Pick<PropertywareClient, 'fetchPage'>,
  entity: PropertywareEntity,
  query: Omit<PropertywarePageQuery, 'offset'>,
  correlationId: string,
) {
  let offset = 0;
  while (true) {
    const page = await client.fetchPage(entity, { ...query, offset }, correlationId);
    yield page;
    const receivedCount = page.receivedCount ?? page.records.length;
    offset += receivedCount;
    if (receivedCount === 0 || receivedCount < page.limit) return;
    if (page.totalCount !== undefined && offset >= page.totalCount) return;
  }
}
