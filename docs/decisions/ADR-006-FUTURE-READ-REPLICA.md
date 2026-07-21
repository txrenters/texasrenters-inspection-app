# ADR-006: Future regional read replica

## Status

Proposed for a later phase; not implemented.

## Context

Technicians primarily operate in the United States and the development team is in the Philippines, while the primary PostgreSQL database is currently in Canada Central. Moving the API beside the primary removes repeated API-to-database WAN latency, but users far from Canada may still benefit from a future read replica when measured traffic justifies its operational cost.

## Decision

Keep all current database traffic on the primary. First deploy the API beside it and measure production latency. Consider a managed Singapore or United States read replica only after verifying provider support, replication lag, failover behavior, connection budgets, and data-residency requirements.

Replica-eligible reads are stale-tolerant, organization-scoped catalog and reporting queries where the response can clearly tolerate replication lag. Primary-only operations include authentication and authorization resolution, technician assignment visibility immediately after mutation, inspection workflow state, uploads, findings and reviews, audit writes, Propertyware synchronization, transactions, and every read-after-write flow.

## Consequences

- No consistency or authorization behavior changes now.
- A future replica needs an explicit repository routing boundary and lag monitoring; replacing `DATABASE_URL` globally is not acceptable.
- Mobile realtime events still originate from primary-backed mutations. A replica response must never overwrite newer client state.
- The added infrastructure is adopted only when measurements show it is more valuable than regional API placement, query reduction, and caching.
