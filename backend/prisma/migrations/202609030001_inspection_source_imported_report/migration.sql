-- An imported report is neither MANUAL nor JOBBER. Additive, so every existing
-- row keeps the value it has and nothing needs backfilling.
--
-- Split from the transaction Prisma would otherwise wrap it in: Postgres
-- refuses to use a new enum value in the same transaction that added it, and a
-- deployment that adds the label and then inserts with it in one go fails on
-- the insert rather than on the migration.
ALTER TYPE "InspectionSource" ADD VALUE IF NOT EXISTS 'IMPORTED_REPORT';
