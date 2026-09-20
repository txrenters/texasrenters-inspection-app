-- A day holds nine visits and a tenth where the properties are on top of each
-- other (the office, 2026-09-20: "minimum of 9 vists maximum of 10. Find the
-- shortest route of each property to the next for efficient scheduling").
--
-- Earlier the same day the office asked for fifteen and settled on ten. Nine is
-- still what a day holds before it asks how near the next visit is; past that it
-- takes one, and only one within five minutes' drive. Drafts laid out on the old
-- fifteen are moved to ten, so the next rebuild uses the new rule; a plan the
-- office has given a number of its own is left alone.

-- AlterTable
ALTER TABLE "TbpQuarterPlan" ALTER COLUMN "maxStopsPerDay" SET DEFAULT 10;

UPDATE "TbpQuarterPlan" SET "maxStopsPerDay" = 10 WHERE "maxStopsPerDay" = 15 AND "status" = 'DRAFT';
