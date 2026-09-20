-- A planned day starts from the technician's home (the office, 2026-09-16).
--
-- The day is routed from the home on the technician's planning profile, and the
-- drive from home to the first property is kept so the console can show it and
-- when to leave. It is not part of the ninety minutes: `totalDriveSeconds` stays
-- the drive between the day's properties, which is what the limit counts.

-- AlterTable
ALTER TABLE "TbpQuarterPlanDay" ADD COLUMN     "homeDriveMeters" INTEGER,
ADD COLUMN     "homeDriveSeconds" INTEGER;
