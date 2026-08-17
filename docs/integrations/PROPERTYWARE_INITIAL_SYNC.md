# Propertyware initial synchronization

Initial synchronization is a one-time, explicit full import of required active Propertyware data. It is not an incremental run with a guessed lookback window.

Run from `backend/`:

1. `npm run propertyware:sync:dry-run`
2. Review sanitized page, record, mapping, and warning counts.
3. `npm run propertyware:sync:initial`
4. `npm run propertyware:verify:db`

The worker processes portfolios, buildings, units, and leases in parent-first order. It omits `lastModifiedDateTimeStart`, validates provider and normalized DTOs, applies idempotent upserts, saves a cursor only after each entity completes, and records per-entity and aggregate metrics.

During the portfolios-and-buildings integration phase, use
`npm run propertyware:sync:buildings:dry-run` followed by
`npm run propertyware:sync:buildings:initial`. This limits the run to the provider
contracts that have been approved while preserving the required parent-first order.

Do not proceed to incremental scheduling if any requested entity failed, lacks a cursor, or unexpectedly returned zero rows. A zero-row response emits `ZERO_RECORDS_WARNING`; check account scope, organization ID, endpoint permissions, active filters, response shape, and pagination before accepting it.

The verification command reads synchronized tables through the backend database connection and reports only organization-scoped counts. It does not print provider credentials or raw payloads. A live import is not considered verified until the database report confirms the expected rows.
