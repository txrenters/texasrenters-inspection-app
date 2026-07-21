import type { CacheConfig } from '../src/cache/cache.config';
import { CacheInvalidationService } from '../src/cache/cache-invalidation.service';
import { CacheKeyService } from '../src/cache/cache-key.service';
import { CacheMetricsService } from '../src/cache/cache-metrics.service';
import { CachePolicy } from '../src/cache/cache-policy';
import { CacheService } from '../src/cache/cache.service';
import { SingleFlightService } from '../src/cache/single-flight.service';

class FakeConnection {
  readonly values = new Map<string, string>();
  connected = true;
  deleted: string[] = [];

  isConnected() {
    return this.connected;
  }
  status() {
    return {
      enabled: true,
      provider: 'redis',
      state: this.connected ? 'connected' : 'unavailable',
    };
  }
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.values.set(key, value);
    return 'OK';
  }
  async del(key: string) {
    this.deleted.push(key);
    return this.values.delete(key) ? 1 : 0;
  }
  async incr(key: string) {
    const next = Number(this.values.get(key) ?? '0') + 1;
    this.values.set(key, String(next));
    return next;
  }
}

const config = (overrides: Partial<CacheConfig> = {}): CacheConfig => ({
  enabled: true,
  provider: 'redis',
  keyPrefix: 'texasrenters',
  defaultTtlSeconds: 60,
  jitterPercent: 15,
  singleFlightEnabled: true,
  metricsEnabled: true,
  failOpen: true,
  maxValueBytes: 262_144,
  redisOptions: {},
  ...overrides,
});

function fixture(overrides: Partial<CacheConfig> = {}) {
  const options = config(overrides);
  const connection = new FakeConnection();
  const metrics = new CacheMetricsService();
  const keys = new CacheKeyService(options);
  const singleFlight = new SingleFlightService(metrics);
  const cache = new CacheService(options, connection as never, keys, metrics, singleFlight);
  return { cache, connection, keys, metrics };
}

describe('shared cache foundation', () => {
  it('normalizes query ordering, changes for filters and scopes, and excludes raw sensitive input', () => {
    const keys = new CacheKeyService(config());
    expect(keys.fingerprint({ page: 1, search: ' Main ' })).toBe(
      keys.fingerprint({ search: 'main', page: 1 }),
    );
    expect(keys.fingerprint({ page: 1 })).not.toBe(keys.fingerprint({ page: 2 }));
    const first = keys.value('properties', 'organization-a', 1, { email: 'Person@Example.com' });
    const second = keys.value('properties', 'organization-b', 1, { email: 'Person@Example.com' });
    expect(first).not.toBe(second);
    expect(first).not.toContain('Person');
    expect(first).not.toContain('example.com');
  });

  it('keeps TTL jitter positive and within configured bounds', () => {
    const policy = new CachePolicy(config({ jitterPercent: 15 }));
    expect(policy.ttl('properties', () => 0)).toBe(102);
    expect(policy.ttl('properties', () => 1)).toBe(138);
  });

  it('serves the second identical request without another database load', async () => {
    const { cache, metrics } = fixture();
    const loader = jest.fn().mockResolvedValue({ items: [{ id: 'property-1' }], total: 1 });
    const options = { resource: 'properties' as const, scope: 'org-1', query: { page: 1 }, loader };
    const first = await cache.getOrLoad(options);
    const second = await cache.getOrLoad(options);
    expect(second).toEqual(first);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot().hits).toBe(1);
  });

  it('repairs a corrupted value by deleting it and loading the database result', async () => {
    const { cache, connection, keys, metrics } = fixture();
    const key = keys.value('properties', 'org-1', 0, { page: 1 });
    connection.values.set(key, '{broken-json');
    const loader = jest.fn().mockResolvedValue({ items: [] });
    await expect(
      cache.getOrLoad({ resource: 'properties', scope: 'org-1', query: { page: 1 }, loader }),
    ).resolves.toEqual({ items: [] });
    expect(connection.deleted).toContain(key);
    expect(metrics.snapshot().byResource.properties?.parseFailures).toBe(1);
  });

  it('bumps only the requested namespace and makes the old key unreachable', async () => {
    const { cache, connection, keys } = fixture();
    await cache.bumpNamespace('properties', 'org-1');
    expect(connection.values.get(keys.namespace('properties', 'org-1'))).toBe('1');
    expect(connection.values.has(keys.namespace('technicians', 'org-1'))).toBe(false);
  });

  it('fails open to PostgreSQL when Redis is unavailable', async () => {
    const { cache, connection, metrics } = fixture();
    connection.connected = false;
    const loader = jest.fn().mockResolvedValue({ id: 'database-result' });
    await expect(
      cache.getOrLoad({ resource: 'propertyDetails', scope: 'org-1', query: { id: '1' }, loader }),
    ).resolves.toEqual({ id: 'database-result' });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot().byResource.propertyDetails?.databaseFallbacks).toBe(1);
  });

  it('skips values over the configured size limit', async () => {
    const { cache, metrics } = fixture({ maxValueBytes: 40 });
    await cache.getOrLoad({
      resource: 'properties',
      scope: 'org-1',
      query: {},
      loader: async () => ({ text: 'x'.repeat(100) }),
    });
    expect(metrics.snapshot().byResource.properties?.valueTooLarge).toBe(1);
  });

  it('deduplicates bounded concurrent cache misses', async () => {
    const { cache, metrics } = fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const loader = jest.fn(async () => {
      await blocked;
      return { id: 'one-load' };
    });
    const options = { resource: 'dashboard' as const, scope: 'org-1', query: {}, loader };
    const requests = [cache.getOrLoad(options), cache.getOrLoad(options), cache.getOrLoad(options)];
    await Promise.resolve();
    release();
    await expect(Promise.all(requests)).resolves.toEqual([
      { id: 'one-load' },
      { id: 'one-load' },
      { id: 'one-load' },
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot().byResource.dashboard?.singleFlightJoins).toBe(2);
  });

  it('batches Propertyware invalidation to one bump per affected resource', async () => {
    const cache = { bumpNamespace: jest.fn().mockResolvedValue(true), invalidate: jest.fn() };
    const service = new CacheInvalidationService(cache as never);
    await service.publish({
      type: 'propertyware.sync.finished',
      organizationId: 'org-1',
      entities: ['buildings', 'units', 'buildings'],
    });
    const resources = cache.bumpNamespace.mock.calls.map(([resource]) => resource);
    expect(resources).toEqual(
      expect.arrayContaining([
        'properties',
        'propertySearch',
        'propertyDetails',
        'units',
        'dashboard',
        'propertywareStatus',
      ]),
    );
    expect(new Set(resources).size).toBe(resources.length);
  });
});
