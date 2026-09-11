-- Where each area sits in a comparison.
--
-- The order was never stored. Every row of one comparison is written by a
-- single `createMany` inside one transaction, and `CURRENT_TIMESTAMP` -- the
-- default behind `createdAt` -- is transaction start time, so all of them share
-- one timestamp to the millisecond. Reading them back with `ORDER BY
-- "createdAt" ASC` is therefore a tie, and a tie is unspecified in SQL: the
-- rows come back in whatever order the scan yields, which changes as the table
-- changes. The areas appeared stable only for as long as the heap happened to
-- hold insertion order, and an import that rewrote the comparison shuffled them.
--
-- Additive and defaulted, because `prisma migrate deploy` is forward-only and
-- the database is never rolled back: comparisons written before this read as
-- position 0 and keep working, and the previous image ignores a column it does
-- not know about. Their order is only recovered when they are regenerated --
-- there is nothing in an existing row that says where it belonged -- but the
-- readers also tie-break on `id`, so an old comparison is at least stable
-- rather than shuffling.
ALTER TABLE "InspectionAreaComparison"
  ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
