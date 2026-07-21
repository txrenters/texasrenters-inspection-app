# Propertyware integration overview

Propertyware is the read-only source of truth for portfolios, portfolio owner summaries, buildings, units, and move-out-relevant leases. Supabase PostgreSQL remains authoritative for inspections, approved rooms, media, transcripts, findings, reviews, reports, and audit history.

The backend fetches and validates Propertyware data, normalizes only selected fields, and performs idempotent upserts. Mobile clients call the TexasRenters REST API only. Local development defaults to `PROPERTYWARE_PROVIDER=mock` and `PROPERTYWARE_STORE=memory`; no provider credential is required.

The official interactive OpenAPI reference is <https://app.propertyware.com/pw/apidocs/>. It exposes a `swagger.json` download; the implementation intentionally records retrieval instructions instead of committing the approximately 694 KB full specification.
