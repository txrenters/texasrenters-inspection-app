import type { CacheConfig } from './cache.config';

export type CacheResource =
  | 'dashboard'
  | 'portfolios'
  | 'properties'
  | 'propertySearch'
  | 'propertyDetails'
  | 'units'
  | 'leases'
  | 'technicians'
  | 'providerReadiness'
  | 'propertywareStatus';

const DEFAULT_TTLS: Record<CacheResource, number> = {
  dashboard: 25,
  portfolios: 600,
  properties: 120,
  propertySearch: 45,
  propertyDetails: 300,
  units: 120,
  leases: 120,
  technicians: 45,
  providerReadiness: 20,
  propertywareStatus: 20,
};

export class CachePolicy {
  constructor(private readonly config: CacheConfig) {}

  ttl(resource: CacheResource, random = Math.random) {
    const environmentName = `CACHE_TTL_${resource.replace(/([A-Z])/g, '_$1').toUpperCase()}_SECONDS`;
    const configured = Number(process.env[environmentName]);
    const base =
      Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTLS[resource];
    const variance = base * (this.config.jitterPercent / 100);
    return Math.max(1, Math.round(base - variance + random() * variance * 2));
  }

  defaults() {
    return { ...DEFAULT_TTLS };
  }
}
