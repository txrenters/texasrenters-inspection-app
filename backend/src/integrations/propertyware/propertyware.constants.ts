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

export const PROPERTYWARE_ENTITIES = ['portfolios', 'buildings', 'units', 'leases'] as const;
export type PropertywareEntity = (typeof PROPERTYWARE_ENTITIES)[number];

export const PROPERTYWARE_ENTITY_ORDER: readonly PropertywareEntity[] = PROPERTYWARE_ENTITIES;
export const PROPERTYWARE_MAX_PAGE_SIZE = 500;
