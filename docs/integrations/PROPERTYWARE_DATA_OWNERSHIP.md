# Propertyware data ownership

Propertyware owns current portfolio, owner relationship, building, unit, and lease metadata. TexasRenters owns inspection assignments, floor plans, approved area snapshots, videos, upload state, transcripts, AI findings, human review, reports, and audit logs.

Synchronization changes only `propertyware_*` tables. An inspection can preserve assignment-time external IDs, names, address, unit/lease context, scheduled move-out date, and an authorized minimal tenant display name in `Inspection.propertySnapshot`. Historical reports must read that snapshot, not mutable current provider rows.

Owner and lease contact emails, phone numbers, addresses, birth dates, financial fields, and full provider payloads are intentionally excluded.
