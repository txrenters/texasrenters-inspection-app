-- Nine to twelve benefit-package visits every day (the office, 2026-09-17).
--
-- Visits take eight to fifteen minutes, twenty at most, so every day holds at
-- least nine and the drive between the properties is kept short rather than
-- capped. The maximum is kept on the plan beside the minimum, and a visit is
-- planned at twenty minutes on every plan not yet published; a published plan
-- keeps the numbers it was booked with. `maxDriveMinutes` stays, as how far a
-- zone may be from the crew's homes.

-- AlterTable
ALTER TABLE "TbpQuarterPlan" ADD COLUMN     "maxStopsPerDay" INTEGER NOT NULL DEFAULT 12,
ALTER COLUMN "occupiedVisitMinutes" SET DEFAULT 20,
ALTER COLUMN "hvacVisitMinutes" SET DEFAULT 20;

UPDATE "TbpQuarterPlan" SET "occupiedVisitMinutes" = 20 WHERE "status" = 'DRAFT' AND "occupiedVisitMinutes" = 30;
UPDATE "TbpQuarterPlan" SET "hvacVisitMinutes" = 20 WHERE "status" = 'DRAFT' AND "hvacVisitMinutes" = 30;
