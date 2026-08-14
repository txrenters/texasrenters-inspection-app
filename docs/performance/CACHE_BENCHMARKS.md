# Cache benchmarks

Measured 2026-07-21 from the Philippines against the development backend/database in Canada Central.

## Pre-cache evidence

The existing API audit recorded warm database-backed medians of 283.2 ms for the 20-row property list, 273.8 ms for property detail, and 812 ms-class behavior for the five-query technician list. A direct public database-health sample in this pass measured one query at 267.8 ms cold and 278.3 ms warm median (four samples). The already-running real-auth API returned 401 for protected benchmark requests because no benchmark bearer token was supplied; that limitation is not treated as a cache result.

## Automated cache-path measurement

The cache suite verifies that an identical second read returns the same serialized DTO with one loader/Prisma surrogate call instead of two. Three simultaneous misses execute one loader and record two single-flight joins. The complete backend suite passed 91 tests. This proves query-count reduction in the cache-aside path but is not a network latency claim.

## Real Redis result

A real before/after Redis latency result was not available on this workstation: TCP 6379 had no listener, Docker was not installed, and the available WSL distribution had no Redis/Valkey server. Therefore this implementation does **not** claim a measured production latency improvement yet. `backend/scripts/perf-endpoints.mjs` now includes dashboard, property list/detail/search, technician list, provider readiness, and Propertyware status and records cold/warm time, query count, database duration, payload, p50-style median, and p95.

The fail-open runtime smoke test started the API with caching enabled against the unavailable local Redis address. `/admin/cache/status` returned `state=unavailable` and `failOpen=true`; an authorized two-row property read still returned HTTP 200 with its two expected Prisma queries. Provider readiness returned without a database query and marked Redis degraded. This validates availability behavior, not cache-hit speed.

Run after starting a local or managed test Redis and a mock-auth backend:

```powershell
$env:CACHE_ENABLED='true'
$env:REDIS_URL='redis://127.0.0.1:6379'
$env:PERF_API_BASE_URL='http://127.0.0.1:3002'
$env:PERF_SAMPLES='20'
node backend/scripts/perf-endpoints.mjs
```

Compare with the same backend using `CACHE_ENABLED=false`. A valid warm hit must show zero Prisma reads for the selected endpoint, an increased cache hit count, unchanged payload/authorization, and lower repeated latency. Redis command latency is available from `/api/v1/admin/cache/metrics`; per-request Redis timing is a known follow-up limitation.
