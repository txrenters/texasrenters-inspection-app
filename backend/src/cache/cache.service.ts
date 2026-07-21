import { Buffer } from 'node:buffer';

import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import { CACHE_CONFIG, type CacheConfig } from './cache.config';
import { CacheKeyService } from './cache-key.service';
import { CacheMetricsService } from './cache-metrics.service';
import { CachePolicy, type CacheResource } from './cache-policy';
import { RedisCacheConnection } from './redis-cache.connection';
import { SingleFlightService } from './single-flight.service';

interface CacheEnvelope<T> {
  schemaVersion: 1;
  cachedAt: string;
  data: T;
}

export interface CacheReadOptions<T> {
  resource: CacheResource;
  scope: string;
  query: unknown;
  loader: () => Promise<T>;
  validate?: (value: unknown) => value is T;
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly policy: CachePolicy;

  constructor(
    @Inject(CACHE_CONFIG) private readonly config: CacheConfig,
    @Inject(RedisCacheConnection) private readonly connection: RedisCacheConnection,
    @Inject(CacheKeyService) private readonly keys: CacheKeyService,
    @Inject(CacheMetricsService) private readonly metrics: CacheMetricsService,
    @Inject(SingleFlightService) private readonly singleFlight: SingleFlightService,
  ) {
    this.policy = new CachePolicy(config);
  }

  async getOrLoad<T>(options: CacheReadOptions<T>): Promise<T> {
    if (!this.config.enabled || !this.connection.isConnected()) {
      if (this.config.enabled) {
        this.metrics.increment('databaseFallbacks', options.resource);
        if (!this.config.failOpen)
          throw new ServiceUnavailableException('The server cache is temporarily unavailable.');
      }
      return options.loader();
    }
    const version = await this.namespaceVersion(options.resource, options.scope);
    const key = this.keys.value(options.resource, options.scope, version, options.query);
    const cached = await this.read<T>(key, options.resource, options.validate);
    if (cached.found) return cached.value;

    const load = () => this.loadAndStore(key, options);
    return this.config.singleFlightEnabled
      ? this.singleFlight.run(key, options.resource, load)
      : load();
  }

  async invalidate(resource: CacheResource, scope: string, query: unknown) {
    if (!this.config.enabled || !this.connection.isConnected()) return true;
    const version = await this.namespaceVersion(resource, scope);
    const deleted = await this.connection.del(this.keys.value(resource, scope, version, query));
    if (deleted === undefined) {
      this.metrics.increment('invalidationFailures', resource);
      return false;
    }
    this.metrics.increment('deletes', resource);
    return true;
  }

  async bumpNamespace(resource: CacheResource, scope: string) {
    if (!this.config.enabled || !this.connection.isConnected()) return true;
    const version = await this.connection.incr(this.keys.namespace(resource, scope));
    if (version === undefined) {
      this.metrics.increment('invalidationFailures', resource);
      return false;
    }
    this.metrics.increment('namespaceBumps', resource);
    this.logger.debug({ event: 'cache_namespace_bumped', resource, version });
    return true;
  }

  status() {
    return {
      ...this.connection.status(),
      failOpen: this.config.failOpen,
      keySchemaVersion: 1,
      ttlSeconds: this.policy.defaults(),
      jitterPercent: this.config.jitterPercent,
      maximumValueBytes: this.config.maxValueBytes,
      singleFlightEnabled: this.config.singleFlightEnabled,
    };
  }

  metricSnapshot() {
    return this.metrics.snapshot();
  }

  private async namespaceVersion(resource: CacheResource, scope: string) {
    const raw = await this.connection.get(this.keys.namespace(resource, scope));
    const version = Number(raw);
    return Number.isSafeInteger(version) && version >= 0 ? version : 0;
  }

  private async read<T>(
    key: string,
    resource: CacheResource,
    validate?: (value: unknown) => value is T,
    recordMiss = true,
  ): Promise<{ found: true; value: T } | { found: false }> {
    const raw = await this.connection.get(key);
    if (raw === undefined) {
      if (recordMiss) this.metrics.increment('databaseFallbacks', resource);
      return { found: false };
    }
    if (raw === null) {
      if (recordMiss) this.metrics.increment('misses', resource);
      return { found: false };
    }
    try {
      const envelope = JSON.parse(raw) as Partial<CacheEnvelope<unknown>>;
      if (
        envelope.schemaVersion !== 1 ||
        typeof envelope.cachedAt !== 'string' ||
        !Object.prototype.hasOwnProperty.call(envelope, 'data') ||
        (validate && !validate(envelope.data))
      )
        throw new Error('Invalid cache envelope');
      this.metrics.increment('hits', resource);
      return { found: true, value: envelope.data as T };
    } catch {
      this.metrics.increment('parseFailures', resource);
      await this.connection.del(key);
      this.logger.warn({ event: 'cache_corrupted_entry_removed', resource });
      return { found: false };
    }
  }

  private async loadAndStore<T>(key: string, options: CacheReadOptions<T>) {
    const secondRead = await this.read<T>(key, options.resource, options.validate, false);
    if (secondRead.found) return secondRead.value;
    const value = await options.loader();
    const serialized = JSON.stringify({
      schemaVersion: 1,
      cachedAt: new Date().toISOString(),
      data: value,
    } satisfies CacheEnvelope<T>);
    if (Buffer.byteLength(serialized) > this.config.maxValueBytes) {
      this.metrics.increment('valueTooLarge', options.resource);
      return value;
    }
    const result = await this.connection.set(key, serialized, this.policy.ttl(options.resource));
    if (result !== undefined) this.metrics.increment('sets', options.resource);
    return value;
  }
}
