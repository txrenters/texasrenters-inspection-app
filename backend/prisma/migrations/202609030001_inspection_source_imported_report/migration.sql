-- An imported report is neither MANUAL nor JOBBER. Additive, so every existing
-- row keeps the value it has and nothing needs backfilling.
--
-- Safe inside the transaction `prisma migrate deploy` wraps this in because it
-- only *adds* the label. Postgres refuses to let a new enum value be used in
-- the transaction that created it, so a migration that added this and then
-- wrote a row with it would fail on the write; nothing here does.
ALTER TYPE "InspectionSource" ADD VALUE IF NOT EXISTS 'IMPORTED_REPORT';
