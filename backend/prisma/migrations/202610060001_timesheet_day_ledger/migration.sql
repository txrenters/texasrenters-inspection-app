-- The timesheet reads a technician's day, not one job at a time (the office,
-- 2026-10-06).
--
-- Read per job, the drive between two properties belonged to neither and was
-- counted nowhere: a fortnight of real work came to 36 hours on site and three
-- minutes of anything else. Two jobs at one building were each given the whole
-- stay. So a stretch now belongs to a property, or to nobody when it is the
-- time between properties:
--
--   * "inspectionId" becomes optional -- general time has no visit.
--   * "buildingId" says which property an on-site stretch was at.
--   * "quietSeconds" is how much of a stretch the phone was silent for. Those
--     minutes are counted now instead of listed for somebody to settle, and
--     this is what keeps them visible.
--
-- The circle is 20 m to arrive and 30 m to leave, where it was 40 and 60. Only
-- the column defaults change here: a property whose distances the office set
-- by hand keeps them, and one with no row reads the defaults from the code.
--
-- Additive: one constraint relaxed, two nullable-or-defaulted columns on an
-- existing table whose tenant policy already covers them.

-- AlterTable
ALTER TABLE "TimeSegment"
  ALTER COLUMN "inspectionId" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "buildingId" UUID,
  ADD COLUMN IF NOT EXISTS "quietSeconds" INTEGER NOT NULL DEFAULT 0;

-- Every stretch written so far was for a job, so its property is the job's.
UPDATE "TimeSegment" AS segment
SET "buildingId" = inspection."propertywareBuildingId"
FROM "Inspection" AS inspection
WHERE inspection."id" = segment."inspectionId"
  AND segment."buildingId" IS NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TimeSegment_buildingId_idx" ON "TimeSegment"("buildingId");

-- AddForeignKey
ALTER TABLE "TimeSegment"
  ADD CONSTRAINT "TimeSegment_buildingId_fkey"
  FOREIGN KEY ("buildingId") REFERENCES "propertyware_buildings"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "PropertyGeofence"
  ALTER COLUMN "enterRadiusMeters" SET DEFAULT 20,
  ALTER COLUMN "exitRadiusMeters" SET DEFAULT 30;
