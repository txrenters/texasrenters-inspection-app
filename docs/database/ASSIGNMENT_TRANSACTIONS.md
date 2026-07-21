# Assignment Transactions and Migration

Migration `202607180005_add_admin_inspection_assignment_schema.sql` extends the existing inspection foundation; it intentionally stops with a clear prerequisite error if `Inspection`, `InspectionAssignment`, or `UserProfile` is absent.

## Guarantees

- `Inspection.propertyId` is nullable so synchronized Propertyware building/unit links can be canonical for new records while legacy records remain valid.
- Inspection rows preserve property and lease snapshots, creation actor, schedule, type, priority, internal notes, and cancellation metadata.
- `InspectionAssignment` records the assigning/ending actors, predecessor link, reason, current flag, and optional idempotency key.
- A partial unique index guarantees one current assignment per inspection.
- Foreign keys connect Propertyware building, unit, and lease records without duplicating provider-owned catalog data.

Application mutations use `Serializable` transactions. Reassignment performs validation, closes the prior assignment, inserts the successor, and writes audit history within one transaction. The service rejects cross-organization inspections and technicians before persistence.

## Rollout

Back up the database, verify the foundation tables, apply migrations in order, run Prisma generation, and execute the backend tests. Existing assignment rows are backfilled with `assignedById=technicianId` because the legacy schema had no actor field; administrators should treat those rows as migrated historical data.
