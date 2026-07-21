# Active record rules

Initial, incremental, and reconciliation provider requests explicitly omit deactivated portfolios, buildings, and units. The client also discards any inactive row returned unexpectedly by an active-only request. Normal catalog queries require the selected record and all required parents to be active.

Deactivation sets `isActive=false`, preserves `sourceStatus`, and records `deactivatedAt`; no synchronized row is hard-deleted. Reactivation clears `deactivatedAt`. A failed or partial reconciliation never deactivates unseen rows.

Propertyware does not document an `includeDeactivated` lease filter. Lease responses are still normalized from their documented `active` field, but absence alone is not treated as provider-confirmed deactivation until production response behavior is validated.
