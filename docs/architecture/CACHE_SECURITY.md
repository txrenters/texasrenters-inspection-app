# Cache security

- Redis is an internal backend dependency. No `NEXT_PUBLIC_*` or `EXPO_PUBLIC_*` Redis setting exists.
- Auth guards and role guards run before cached controller responses. Cache scope comes from the authenticated backend context, never a client-supplied user ID.
- Organization scopes and queries are SHA-256 fingerprints; keys contain no raw PII.
- Values are normalized API DTO envelopes, not Prisma models, provider payloads, tokens, passwords, signed media URLs, floor-plan bytes, transcripts, or audit histories.
- Managed Redis should use `rediss://` or `REDIS_TLS=true`, private networking, least-privilege credentials, and the same/nearby region as the NestJS API and Canada Central database.
- Cache admin routes require `SYSTEM_ADMIN` and accept allowlisted resources only. They expose no credentials, cached values, arbitrary commands, patterns, or database-wide flush.
- Parsing is plain bounded JSON with envelope checks. Invalid entries are deleted and loaded from PostgreSQL.
- Redis URLs, usernames, passwords, cached content, and high-cardinality record IDs are excluded from logs and metrics.

The cache is not an authorization source. Role elevation, account deactivation, authentication, and current technician assignments remain database-backed and uncached in this release.
