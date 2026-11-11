import { randomBytes } from 'node:crypto';

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import Redis, { type RedisOptions } from 'ioredis';

import { readPortalConfig } from './portal.config';

/**
 * Where portal sign-ins keep their server-side state: Redis.
 *
 * This app has no server-side session store. A session is a chain of rotating
 * refresh tokens in Postgres (`AuthRefreshToken`), and the schema was to gain
 * one column for the portal and nothing more. So what the portal needs to keep
 * beside a session lives here:
 *
 * - **a sign-in in progress** (`flow`): the `state`, the PKCE verifier and
 *   where the person was going. Ten minutes, and read exactly once.
 * - **a signed-in portal session** (`session`): who it belongs to, the
 *   portal's refresh token (sealed), and when the portal last said yes. It
 *   lasts as long as a portal sign-in can, twelve hours.
 * - **a lock per portal session**, so two requests can never send the same
 *   portal refresh token at once. It rotates on every use: the second of two
 *   parallel refreshes would revoke the first and sign the person out.
 *
 * Production Redis is not persisted. A restart therefore ends every portal
 * session, and the next renewal sends each person back through the portal —
 * usually one click, since the portal remembers them for its twelve hours. The
 * Postgres session is what records a sign-out, so losing this state can end a
 * session early but never keep one alive.
 *
 * Every method throws `PortalStoreUnavailableError` when Redis cannot be
 * reached, and callers decide what that means for them.
 */

export class PortalStoreUnavailableError extends Error {
  constructor() {
    super('The portal session store is unavailable.');
    this.name = 'PortalStoreUnavailableError';
  }
}

export interface PortalFlow {
  state: string;
  verifier: string;
  returnTo: string;
}

export interface PortalSessionRecord {
  authUserId: string;
  /** The portal's `sub`. */
  subject: string;
  /** The portal's refresh token, sealed with `portalTokenKey`. Never stored in the clear. */
  refreshToken: string;
  /** Epoch milliseconds the portal last confirmed this session. */
  checkedAt: number;
  /** Epoch milliseconds of the portal sign-in itself. */
  startedAt: number;
}

export abstract class PortalStore {
  abstract saveFlow(id: string, flow: PortalFlow, ttlSeconds: number): Promise<void>;
  /** Reads and deletes in one step, so a flow can be used once whatever happens next. */
  abstract takeFlow(id: string): Promise<PortalFlow | null>;
  abstract saveSession(id: string, record: PortalSessionRecord, ttlSeconds: number): Promise<void>;
  /**
   * Replaces a session that still exists, keeping its expiry. Returns false
   * when it has gone — ended while the portal was being asked — so an ended
   * session is never written back into existence.
   */
  abstract updateSession(id: string, record: PortalSessionRecord): Promise<boolean>;
  abstract readSession(id: string): Promise<PortalSessionRecord | null>;
  abstract endSession(id: string, authUserId: string): Promise<void>;
  /** Ends every portal session one account has. Returns how many there were. */
  abstract endSessionsOf(authUserId: string): Promise<number>;
  /** A lock token when this caller now holds the lock, null when someone else does. */
  abstract acquireLock(id: string, ttlMs: number): Promise<string | null>;
  abstract releaseLock(id: string, token: string): Promise<void>;
  /** Counts one request against a fixed window and returns the count so far. */
  abstract countRequest(key: string, windowSeconds: number): Promise<number>;
}

/** Deletes the lock only if it is still ours: an expired lock may belong to someone else by now. */
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

@Injectable()
export class RedisPortalStore extends PortalStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisPortalStore.name);
  private client?: Redis;
  private everReady = false;
  private lastErrorLoggedAt = 0;

  /** Connects at boot when the portal is on, so the first sign-in does not wait for it. */
  onModuleInit() {
    if (readPortalConfig().requested) this.connection();
  }

  async onModuleDestroy() {
    if (!this.client) return;
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect(false);
    }
  }

  async saveFlow(id: string, flow: PortalFlow, ttlSeconds: number) {
    await this.run((redis) => redis.set(this.key('flow', id), JSON.stringify(flow), 'EX', ttlSeconds));
  }

  async takeFlow(id: string) {
    const raw = await this.run((redis) => redis.getdel(this.key('flow', id)));
    return raw ? (JSON.parse(raw) as PortalFlow) : null;
  }

  async saveSession(id: string, record: PortalSessionRecord, ttlSeconds: number) {
    const userKey = this.key('user', record.authUserId);
    await this.run((redis) =>
      redis
        .multi()
        .set(this.key('session', id), JSON.stringify(record), 'EX', ttlSeconds)
        .sadd(userKey, id)
        // The index lives as long as the newest session in it, so it can never
        // outlast every session it names by more than one sign-in's length.
        .expire(userKey, ttlSeconds)
        .exec(),
    );
  }

  async updateSession(id: string, record: PortalSessionRecord) {
    const result = await this.run((redis) =>
      redis.set(this.key('session', id), JSON.stringify(record), 'KEEPTTL', 'XX'),
    );
    return result === 'OK';
  }

  async readSession(id: string) {
    const raw = await this.run((redis) => redis.get(this.key('session', id)));
    return raw ? (JSON.parse(raw) as PortalSessionRecord) : null;
  }

  async endSession(id: string, authUserId: string) {
    await this.run((redis) =>
      redis.multi().del(this.key('session', id)).srem(this.key('user', authUserId), id).exec(),
    );
  }

  async endSessionsOf(authUserId: string) {
    const userKey = this.key('user', authUserId);
    const ids = await this.run((redis) => redis.smembers(userKey));
    const results = await this.run((redis) => {
      const batch = redis.multi();
      for (const id of ids) batch.del(this.key('session', id));
      return batch.del(userKey).exec();
    });
    // Count the sessions that were really there: the index can name ones that
    // already expired on their own.
    return (results ?? []).slice(0, ids.length).filter(([, deleted]) => deleted === 1).length;
  }

  async acquireLock(id: string, ttlMs: number) {
    const token = randomBytes(16).toString('base64url');
    const result = await this.run((redis) => redis.set(this.key('lock', id), token, 'PX', ttlMs, 'NX'));
    return result === 'OK' ? token : null;
  }

  async releaseLock(id: string, token: string) {
    await this.run((redis) => redis.eval(RELEASE_LOCK, 1, this.key('lock', id), token));
  }

  async countRequest(key: string, windowSeconds: number) {
    const results = await this.run((redis) =>
      redis.multi().incr(this.key('rate', key)).expire(this.key('rate', key), windowSeconds).exec(),
    );
    const count = results?.[0]?.[1];
    return typeof count === 'number' ? count : 0;
  }

  /** Same prefix as the cache, so two stacks sharing one Redis never read each other's sessions. */
  private key(kind: string, id: string) {
    return `${process.env.CACHE_KEY_PREFIX?.trim() || 'texasrenters'}:portal:${kind}:${id}`;
  }

  private async run<T>(operation: (redis: Redis) => Promise<T>): Promise<T> {
    const redis = this.connection();
    if (!(await this.ready(redis))) throw new PortalStoreUnavailableError();
    try {
      return await operation(redis);
    } catch {
      this.warn('portal_store_command_failed');
      throw new PortalStoreUnavailableError();
    }
  }

  /**
   * Its own connection rather than the cache's.
   *
   * The cache connection gives up reconnecting after three attempts and
   * answers every command with `undefined` from then on, which is right for a
   * cache and wrong here: a session that can never be checked again must come
   * back once Redis does. Created on first use, so a backend with the portal
   * switched off never connects at all.
   */
  private connection() {
    if (this.client) return this.client;
    const url = process.env.REDIS_URL?.trim() || undefined;
    const options: RedisOptions = {
      host: url ? undefined : process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT) || 6379,
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
      tls: process.env.REDIS_TLS === 'true' || url?.startsWith('rediss://') ? {} : undefined,
      lazyConnect: true,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
      maxRetriesPerRequest: 1,
      // Fail fast while disconnected rather than queueing: a sign-in waiting on
      // Redis is worse than one told to try again.
      enableOfflineQueue: false,
      retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
    };
    this.client = url ? new Redis(url, options) : new Redis(options);
    this.client.on('error', () => this.warn('portal_store_connection_error'));
    this.client.on('ready', () => {
      this.everReady = true;
    });
    this.client.connect().catch(() => undefined);
    return this.client;
  }

  /**
   * Waits for the first connection, briefly; after that, fails fast.
   *
   * Waiting during an outage would put two seconds on every request a portal
   * session makes, since each one is checked here. Only the connection opened
   * at boot is worth waiting for.
   */
  private async ready(redis: Redis) {
    if (redis.status === 'ready') return true;
    if (this.everReady || redis.status === 'end') return false;
    return new Promise<boolean>((resolve) => {
      const done = (ready: boolean) => {
        clearTimeout(timer);
        redis.off('ready', onReady);
        resolve(ready);
      };
      const onReady = () => done(true);
      const timer = setTimeout(() => done(false), 2_000);
      redis.once('ready', onReady);
    });
  }

  /** At most one warning a minute: a Redis outage would otherwise log on every request. */
  private warn(event: string) {
    const now = Date.now();
    if (now - this.lastErrorLoggedAt < 60_000) return;
    this.lastErrorLoggedAt = now;
    this.logger.warn({ event });
  }
}
