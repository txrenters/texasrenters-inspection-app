# Redis runbook

## Configuration

Set `CACHE_ENABLED=true` and prefer `REDIS_URL`. Alternatively configure `REDIS_HOST`, `REDIS_PORT`, `REDIS_USERNAME`, `REDIS_PASSWORD`, and `REDIS_TLS`. Keep all values in backend secret storage. Local Docker Compose already places Redis beside the backend. Production Redis should be in the same or a nearby Canada region as the API and Supabase PostgreSQL; supported choices include a managed Redis/Valkey service from the selected cloud vendor or a private Upstash/Redis Cloud deployment with TLS.

Useful policy settings are `CACHE_TTL_JITTER_PERCENT`, `CACHE_MAX_VALUE_BYTES`, `CACHE_SINGLE_FLIGHT_ENABLED`, `CACHE_METRICS_ENABLED`, and `CACHE_FAIL_OPEN`. Resource TTL overrides use `CACHE_TTL_<RESOURCE>_SECONDS`, for example `CACHE_TTL_PROPERTIES_SECONDS=120`.

## Readiness and metrics

System administrators can use:

```text
GET  /api/v1/admin/cache/status
GET  /api/v1/admin/cache/metrics
POST /api/v1/admin/cache/invalidate
POST /api/v1/admin/cache/bump-namespace
```

Readiness is `configured`, `connected`, `degraded`, `unavailable`, or `disabled`. Metrics include hits, misses, hit ratio, average Redis command latency, database fallbacks, sets, deletes, namespace bumps, invalidation/parse/size failures, connection failures, and single-flight joins, tagged only by safe resource category.

## Outage

With fail-open enabled, verify PostgreSQL health, observe `databaseFallbacks`, and restore Redis without restarting clients. The connection retries a bounded startup sequence and resumes after an `ioredis` ready event. Do not disable Windows or infrastructure firewalls globally. Do not log the connection URL while diagnosing.

No startup warming occurs. After recovery, normal requests repopulate bounded pages.
