# Propertyware Admin Operations

The admin application exposes read-only Propertyware catalog synchronization. No Propertyware mutation endpoint is implemented.

## Actions

- Initial sync: imports active portfolios, buildings, units, and move-out-relevant leases.
- Incremental sync: reads changes from stored cursors.
- Reconciliation: compares the current source population and deactivates records no longer present.

Actions enqueue work and return immediately. The page polls status and the latest 50 runs every 15 seconds while mounted. Manual actions are rate-limited to five per user per minute and require `SYSTEM_ADMIN` or `PROPERTY_ADMIN`.

## Safe operation

Run a dry-run and database population verification before enabling scheduled live sync. Check failed-record and warning counts after each initial or reconciliation run. Synced source records are normalized and retained with external IDs, source status, hashes, timestamps, and active/inactive state.

Credentials live only in backend environment variables. The admin status page may display provider state, cursors, counts, and sanitized errors; it must never display credentials or raw private provider payloads.

Use the established commands in `docs/integrations/PROPERTYWARE_OPERATIONS.md` for CLI diagnostics and recovery.
