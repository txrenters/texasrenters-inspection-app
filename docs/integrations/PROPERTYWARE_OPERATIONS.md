# Propertyware operations

Keep `PROPERTYWARE_PROVIDER=mock` for local fixture runs. Live mode fails configuration validation unless all three credentials are present. Use read-only Propertyware permissions for portfolios, buildings, units, and leases.

Manual administrator endpoints:

- `POST /api/v1/admin/integrations/propertyware/sync/initial`
- `POST /api/v1/admin/integrations/propertyware/sync/incremental`
- `POST /api/v1/admin/integrations/propertyware/reconcile`
- `GET /api/v1/admin/integrations/propertyware/sync-runs`
- `GET /api/v1/admin/integrations/propertyware/sync-runs/{id}`
- `GET /api/v1/admin/integrations/propertyware/status`

The non-admin integration paths remain as compatibility aliases and enforce the same administrator roles.

Operator commands (run from the backend package) are `propertyware:status`, `propertyware:sync:dry-run`, `propertyware:sync:initial`, `propertyware:sync:incremental`, `propertyware:reconcile`, and `propertyware:verify:db`. Live commands require backend-only credentials. Always run dry-run first, then initial sync, then direct database verification. Do not report a successful population from HTTP status alone.

Automatic scheduling remains disabled when `PROPERTYWARE_SYNC_ENABLED=false`. Example cron values in `.env.example` require operational approval and a production scheduler/queue deployment before enablement. Recovery is a new incremental run or full reconciliation after fixing credentials/provider availability; never edit sync cursors during an active run.
