# Propertyware operator runbook

## Before a live run

- Confirm `PROPERTYWARE_CLIENT_ID`, `PROPERTYWARE_CLIENT_SECRET`, and `PROPERTYWARE_ORGANIZATION_ID` exist only in backend environment configuration.
- Confirm the API account has read access to portfolios, buildings, units, and leases.
- Apply the canonical Propertyware migrations, including the sync-warning columns.
- Keep `PROPERTYWARE_SYNC_ENABLED=false` until initial population is verified.

## Safe execution order

1. Run `npm run propertyware:status` and ensure no sync is active.
2. Run `npm run propertyware:sync:dry-run`. This performs no database writes.
3. Resolve authentication, validation, pagination, or zero-record warnings.
4. Run `npm run propertyware:sync:initial` once the dry-run counts are credible.
5. Run `npm run propertyware:verify:db` and compare the database counts with the completed sync metrics.
6. Only then use `npm run propertyware:sync:incremental` for changed records.
7. Use `npm run propertyware:reconcile` periodically to confirm and soft-deactivate inactive parents and units.

## Failure handling

- `PROPERTYWARE_INITIAL_SYNC_REQUIRED`: run the initial synchronization for the requested entity set; do not manufacture a cursor.
- `ZERO_RECORDS_WARNING`: verify account scope, organization ID, endpoint permissions, filters, response wrappers, and pagination.
- Authentication failure: rotate or correct backend credentials and repeat dry-run.
- Provider throttling or outage: allow bounded retries to finish, then start a new run; do not edit an active run.
- Parent missing during upsert: rerun from the parent-first initial path and inspect the sanitized sync error.

Never delete synchronized rows to repair a run. Reconciliation uses soft deactivation and preserves inspection, assignment, media, review, finding, and audit history.
