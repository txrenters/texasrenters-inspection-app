import {
  PROPERTYWARE_ENTITIES,
  type PropertywareEntity as PropertywareEntityName,
} from '@texasrenters/shared';

export const PROPERTYWARE_SOURCE_SYSTEM = 'propertyware';

export const PROPERTYWARE_AUTH_HEADERS = {
  clientId: 'x-propertyware-client-id',
  clientSecret: 'x-propertyware-client-secret',
  organizationId: 'x-propertyware-system-id',
} as const;

export const PROPERTYWARE_ENDPOINTS = {
  portfolios: '/portfolios',
  buildings: '/buildings',
  units: '/units',
  leases: '/leases',
} as const;

// Re-exported from shared so the API's validation list and the web app's
// request list can never drift apart again.
export { PROPERTYWARE_ENTITIES, type PropertywareEntity } from '@texasrenters/shared';

export const PROPERTYWARE_ENTITY_ORDER: readonly PropertywareEntityName[] = PROPERTYWARE_ENTITIES;
export const PROPERTYWARE_MAX_PAGE_SIZE = 500;
