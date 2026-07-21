# Cache recovery

Use recovery only after direct SQL/Supabase maintenance, a confirmed missed invalidation, schema deployment, or corrupted operational data.

1. Confirm PostgreSQL contains the correct source-of-truth record.
2. Inspect `/api/v1/admin/cache/status` and `/metrics` as a system administrator.
3. Bump the smallest affected namespace:

```json
{ "namespace": "properties" }
```

4. Bump `propertySearch` when property display or membership changed, and `propertyDetails` when a property/unit/lease summary changed.
5. Repeat the read and verify a miss followed by a fresh response and subsequent hit.

For one precisely known cached input, `/cache/invalidate` accepts an allowlisted `resource` plus `id` or a bounded query object. Prefer namespace bump when multiple pages or filter variants may be affected.

Never use `KEYS`, `FLUSHALL`, `FLUSHDB`, a wildcard delete, or direct cached-value editing. Old namespace versions expire through their existing TTL. If Redis is unavailable, leave `CACHE_FAIL_OPEN=true`, repair the service, and let reads repopulate it.
