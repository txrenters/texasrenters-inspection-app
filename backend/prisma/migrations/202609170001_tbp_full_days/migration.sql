-- Full benefit-package days (the office, 2026-09-16).
--
-- At least nine visits a day where the properties allow it, each visit thirty
-- minutes whatever its kind, inside six hours on site and ninety minutes driving
-- between the properties. The minimum is kept on the plan beside its other
-- limits, and the HVAC visit's length follows the office on every plan not yet
-- published; a published plan keeps the numbers it was booked with.

-- AlterTable
ALTER TABLE "TbpQuarterPlan" ADD COLUMN     "minStopsPerDay" INTEGER NOT NULL DEFAULT 9,
ALTER COLUMN "hvacVisitMinutes" SET DEFAULT 30;

UPDATE "TbpQuarterPlan" SET "hvacVisitMinutes" = 30 WHERE "status" = 'DRAFT' AND "hvacVisitMinutes" = 45;
