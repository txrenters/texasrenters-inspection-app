# Propertyware synchronization design

Entities run in dependency order: portfolios and owners, buildings, units, then leases. A distinct `initial` run fetches all active records without a modified-since lower bound. An `incremental` run is rejected until every requested entity has a successful cursor; it then uses that cursor minus a two-minute configurable overlap. The successful cursor advances only after every page for that entity is fetched, validated, mapped, and persisted.

Normalized values receive a stable SHA-256 hash. New rows are inserted; changed rows are updated; unchanged rows only refresh synchronization/seen timestamps. Parent external IDs are retained for repairability and local UUID foreign keys enforce relationships.

Reconciliation is a separate active-only job. Portfolios, buildings, and units use `includeDeactivated=false`; a previously synchronized local row is marked inactive only when it is absent after the complete active-feed traversal succeeds. The same row and all inspection-owned history remain present. A database lock row prevents concurrent workers across API instances.

Dry-run calls the provider, paginates, validates raw records, maps normalized records, and reports sanitized counts without creating a run, cursor, or synchronized row. Every zero-record entity produces `ZERO_RECORDS_WARNING`; zero rows are not treated as proof that account scope and filters are correct.
