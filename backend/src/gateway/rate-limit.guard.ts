/* Injection tokens are runtime imports required by Nest metadata. */
import { HttpException, HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';

import { RedisCacheConnection } from '../cache/redis-cache.connection';
import type { ApiKeyRequest } from './api-key.guard';

const WINDOW_SECONDS = 60;
/** Keep the in-process fallback from growing without bound on a long-lived process. */
const MAX_TRACKED_CLIENTS = 10_000;

interface LocalWindow {
  count: number;
  resetAtMs: number;
}

/**
 * Per-client request limiting for third-party traffic.
 *
 * Counted per **client**, not per key, so issuing a second key during a rotation
 * cannot be used — accidentally or otherwise — to double an integration's
 * allowance.
 *
 * Redis-backed where available, because the API runs as several containers
 * behind one proxy and a per-process counter would silently multiply every limit
 * by the replica count. The in-process fallback is not an equivalent: it is what
 * keeps a Redis outage from removing the limiter altogether, and it is
 * deliberately the stricter interpretation — each replica enforces the full
 * limit rather than a share of it.
 */
@Injectable()
export class ApiRateLimitGuard implements CanActivate {
  private readonly local = new Map<string, LocalWindow>();

  constructor(
    @Optional() @Inject(RedisCacheConnection) private readonly redis?: RedisCacheConnection,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ApiKeyRequest>();
    const clientId = request.user?.apiClientId;
    // Runs after ApiKeyGuard, so a request with no machine principal is a person
    // and is not this guard's business.
    if (!clientId) return true;

    const limit = request.apiClientRateLimit ?? 60;
    const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
    const key = `api-rate:${clientId}:${window}`;
    const count = (await this.redis?.incrementInWindow(key, WINDOW_SECONDS * 2)) ?? this.localCount(key);
    const remaining = Math.max(0, limit - count);
    const resetSeconds = (window + 1) * WINDOW_SECONDS - Math.floor(Date.now() / 1000);

    const response = context.switchToHttp().getResponse<Response>();
    // Published on every response, not only on rejection, so an integrator can
    // pace themselves instead of discovering the limit by hitting it.
    response.setHeader('x-ratelimit-limit', String(limit));
    response.setHeader('x-ratelimit-remaining', String(remaining));
    response.setHeader('x-ratelimit-reset', String(resetSeconds));

    if (count > limit) {
      response.setHeader('retry-after', String(resetSeconds));
      throw new HttpException(
        'Rate limit exceeded for this API client.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  private localCount(key: string) {
    const now = Date.now();
    if (this.local.size > MAX_TRACKED_CLIENTS) {
      for (const [tracked, window] of this.local)
        if (window.resetAtMs <= now) this.local.delete(tracked);
    }
    const existing = this.local.get(key);
    if (existing && existing.resetAtMs > now) {
      existing.count += 1;
      return existing.count;
    }
    this.local.set(key, { count: 1, resetAtMs: now + WINDOW_SECONDS * 1_000 });
    return 1;
  }
}
