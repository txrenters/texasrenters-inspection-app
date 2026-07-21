# Manual Inspection Assignment

Only `SYSTEM_ADMIN`, `PROPERTY_ADMIN`, and `INSPECTION_SUPERVISOR` can access the admin controller. A target technician must be active and have an `INSPECTION_TECHNICIAN` membership in the same organization.

An inspection has at most one current assignment. Assignment rows are append-only history:

- Assign creates a row with `isCurrent=true`, the actor, optional reason, and idempotency key.
- Reassign closes the current row (`isCurrent=false`, `endedAt`, `endedById`, `REASSIGNED`) and creates a successor linked by `supersedesId`.
- Unassign closes the current row as `UNASSIGNED`; it does not delete it.
- Technician deactivation fails while any current assignment remains.

All mutations run in a serializable Prisma transaction. The database partial unique index on `inspectionId WHERE isCurrent=true` is the final concurrency guard. Every mutation writes an audit record in the same transaction.

The UI displays the full history and requires an explicit action for assignment changes. It never interprets assignment as approval of findings, charges, or legal responsibility.
