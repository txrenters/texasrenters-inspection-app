-- A day takes up to fifteen visits where the properties are on top of each other
-- (the office, 2026-09-20: "that should be 9-12-15 if all area's is just 2-5
-- mins away then we can assign at least 15 visits").
--
-- Nine is still what a day holds before it asks how near the next visit is;
-- past that it only takes one within five minutes' drive. Drafts laid out on
-- the old twelve are moved to fifteen, so the next rebuild uses the new rule;
-- a plan the office has given a number of its own is left alone.

-- AlterTable
ALTER TABLE "TbpQuarterPlan" ALTER COLUMN "maxStopsPerDay" SET DEFAULT 15;

UPDATE "TbpQuarterPlan" SET "maxStopsPerDay" = 15 WHERE "maxStopsPerDay" = 12 AND "status" = 'DRAFT';
