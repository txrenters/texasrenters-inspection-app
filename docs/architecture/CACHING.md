# Backend caching

TexasRenters uses Redis as an optional, shared, backend-only cache. PostgreSQL through Prisma remains the source of truth. Web and mobile continue to call the same NestJS REST API and never receive Redis credentials.

## Read flow

For an authorized cacheable read, NestJS derives a trusted organization or global scope, normalizes the bounded query, reads the resource namespace version, and checks Redis. A validated schema-versioned DTO envelope is returned on a hit. A miss runs the precise Prisma query, stores the normalized response with TTL and jitter, and returns it. Invalid JSON or envelopes are deleted and repaired from PostgreSQL.

The first release caches admin dashboard, active portfolios, active properties, property search, property detail, units, leases, active technician lists, provider readiness, and Propertyware status. It deliberately does not cache authentication, assignment/current technician work, inspection mutations, active room/media/provider processing, audit writes, tokens, passwords, tenant PII, raw Propertyware payloads, floor-plan bytes, or AI review decisions.

## Runtime behavior

`CacheModule` is global and owns one `ioredis` connection per backend process. `CACHE_ENABLED=false` disables all cache calls. With the default `CACHE_FAIL_OPEN=true`, an unavailable Redis server causes a database fallback and sanitized metrics/logs; it does not block property browsing or login. `CACHE_FAIL_OPEN=false` is available only for a future workload that explicitly requires Redis.

Concurrent misses for one key share an in-process promise. This protects a single API process. The abstraction leaves distributed locking as a future multi-instance extension; no unbounded Redis lock is used today. Stale-while-revalidate is intentionally disabled because the current invalidation and TTL policy is easier to reason about.

Every cached value has `{ schemaVersion: 1, cachedAt, data }`, a configured maximum size, and a resource TTL. Large values are skipped. Cache warming is not enabled.
