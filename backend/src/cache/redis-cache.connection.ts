import { performance } from 'node:perf_hooks';

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';

import { CACHE_CONFIG, type CacheConfig } from './cache.config';
import { CacheMetricsService } from './cache-metrics.service';

export type CacheReadiness = 'configured' | 'connected' | 'degraded' | 'unavailable' | 'disabled';

@Injectable()
export class RedisCacheConnection implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheConnection.name);
  private client?: Redis;
  private state: CacheReadiness;
  private lastErrorAt?: string;

  constructor(
    @Inject(CACHE_CONFIG) private readonly config: CacheConfig,
    @Inject(CacheMetricsService) private readonly metrics: CacheMetricsService,
  ) {
    this.state = config.enabled ? 'configured' : 'disabled';
  }

  async onModuleInit() {
    if (!this.config.enabled) return;
    this.client = this.config.redisUrl
      ? new Redis(this.config.redisUrl, this.config.redisOptions)
      : new Redis(this.config.redisOptions);
    this.client.on('ready', () => {
      this.state = 'connected';
      this.logger.log({ event: 'redis_connected' });
    });
    this.client.on('error', () => this.markUnavailable('redis_connection_error'));
    this.client.on('close', () => {
      if (this.state === 'connected') this.state = 'degraded';
    });
    try {
      await this.client.connect();
      await this.client.ping();
      this.state = 'connected';
    } catch {
      this.markUnavailable('redis_startup_unavailable');
    }
  }

  async onModuleDestroy() {
    if (!this.client) return;
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect(false);
    }
  }

  isConnected() {
    return this.state === 'connected' && this.client?.status === 'ready';
  }

  status() {
    return {
      enabled: this.config.enabled,
      provider: this.config.provider,
      state: this.state,
      tls: Boolean(this.config.redisOptions.tls),
      lastErrorAt: this.lastErrorAt ?? null,
    };
  }

  get(key: string) {
    return this.command((client) => client.get(key));
  }

  set(key: string, value: string, ttlSeconds?: number) {
    return this.command((client) =>
      ttlSeconds ? client.set(key, value, 'EX', ttlSeconds) : client.set(key, value),
    );
  }

  del(key: string) {
    return this.command((client) => client.del(key));
  }

  incr(key: string) {
    return this.command((client) => client.incr(key));
  }

  /**
   * Increment a counter and make sure it expires, in one round trip.
   *
   * `INCR` then `EXPIRE` as separate calls has a real failure mode: if the
   * second is lost, the counter never resets and the caller it belongs to is
   * rate-limited forever. Pipelining them removes the window; setting the TTL on
   * every increment rather than only on creation costs nothing and means a
   * counter that somehow lost its expiry repairs itself on the next request.
   *
   * Returns `undefined` when Redis is unavailable, like every other command
   * here, so the caller decides what an unavailable limiter should mean.
   */
  async incrementInWindow(key: string, ttlSeconds: number) {
    const results = await this.command((client) =>
      client.pipeline().incr(key).expire(key, ttlSeconds).exec(),
    );
    const count = results?.[0]?.[1];
    return typeof count === 'number' ? count : undefined;
  }

  private async command<T>(operation: (client: Redis) => Promise<T>): Promise<T | undefined> {
    if (!this.isConnected() || !this.client) return undefined;
    const startedAt = performance.now();
    try {
      return await operation(this.client);
    } catch {
      this.state = 'degraded';
      this.markUnavailable('redis_command_failed', false);
      return undefined;
    } finally {
      this.metrics.observeRedis(performance.now() - startedAt);
    }
  }

  private markUnavailable(event: string, unavailable = true) {
    if (unavailable) this.state = 'unavailable';
    this.lastErrorAt = new Date().toISOString();
    this.metrics.increment('connectionFailures');
    this.logger.warn({ event, state: this.state });
  }
}
