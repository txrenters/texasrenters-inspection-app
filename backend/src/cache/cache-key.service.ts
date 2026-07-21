import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { CACHE_CONFIG, type CacheConfig } from './cache.config';
import type { CacheResource } from './cache-policy';

@Injectable()
export class CacheKeyService {
  constructor(@Inject(CACHE_CONFIG) private readonly config: CacheConfig) {}

  namespace(resource: CacheResource, trustedScope: string) {
    return `${this.base(resource, trustedScope)}:namespace`;
  }

  value(resource: CacheResource, trustedScope: string, version: number, input: unknown) {
    return `${this.base(resource, trustedScope)}:ns:${version}:query:${this.fingerprint(input)}`;
  }

  fingerprint(input: unknown) {
    return createHash('sha256')
      .update(JSON.stringify(this.normalize(input)))
      .digest('hex')
      .slice(0, 32);
  }

  normalize(input: unknown): unknown {
    if (input === undefined || input === null || input === '') return null;
    if (typeof input === 'string') return input.trim().toLowerCase().slice(0, 200);
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input === 'boolean') return input;
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input)) return input.map((item) => this.normalize(item));
    if (typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, value]) => value !== undefined && value !== '')
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => [key, this.normalize(value)]),
      );
    return String(input).slice(0, 200);
  }

  private base(resource: CacheResource, trustedScope: string) {
    const scope = createHash('sha256').update(trustedScope).digest('hex').slice(0, 20);
    return `${this.config.keyPrefix}:v1:${resource}:scope:${scope}`;
  }
}
