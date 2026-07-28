# Regional deployment guidance

## Current constraint

The primary Supabase PostgreSQL project is in Canada Central. A persistent API process running on a Philippine developer workstation pays a wide-area round trip for every database query. The measured warm floor is approximately 270–310 ms per database round trip even after connection reuse.

## Recommended topology

Run the NestJS backend as a persistent service in the same cloud region as the primary database. Web and mobile clients continue to call its versioned REST API over HTTPS; they never connect to PostgreSQL or receive privileged credentials.

The service must:

- use the Supabase transaction pooler on port 6543 with Prisma PgBouncer mode for runtime traffic;
- reserve the session-pooler `DIRECT_URL` on port 5432 for Prisma administrative and migration operations;
- start only after Prisma connects and a warm-up `SELECT 1` succeeds;
- expose `/api/v1/health` for liveness and `/api/v1/health/database` plus readiness for database status;
- handle termination through Nest shutdown hooks so Prisma disconnects cleanly;
- keep the instance count and Prisma connection limits within the Supabase plan's database connection budget;
- use HTTPS, a production allowlist for CORS, and a secret manager for configuration.

Do not deploy from this document alone. Confirm the exact Supabase project region, provider capacity, session-pooler limits, backup policy, and the chosen runtime's health-check and graceful-shutdown behavior first.

## Client routing

Production clients should use the stable regional API origin. Expo `--tunnel` affects how Expo Go obtains the JavaScript development bundle; it is not an application data transport and must not be committed as the REST API base URL. Local devices may use a LAN-reachable backend URL during development.

## Verification after deployment

1. Run database and endpoint benchmarks from the API instance.
2. Confirm readiness fails if the database warm-up fails.
3. Load-test at expected and burst concurrency while watching database connections.
4. Confirm private REST responses remain `no-store` and compressed where appropriate.
5. Confirm mobile realtime assignment events and push notifications still invalidate the REST cache.
