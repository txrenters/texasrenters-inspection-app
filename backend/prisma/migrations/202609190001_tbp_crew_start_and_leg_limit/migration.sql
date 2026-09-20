-- A plan built for the crew the coordinator chooses, from a start of its own,
-- in days of nine with no drive over twenty minutes between two properties
-- (the office, 2026-09-19).
--
-- "group the properties into 9 and make sure those grouping is the least drive
-- time" and "I don't want to see a grouping that from one property to other
-- property that will get more than 20mins of drive time": the longest drive
-- allowed between a day's properties is kept on the plan, like its other rules.
-- "Before generating ... it should ask for the technicians" and "schedule 15
-- days before the start of quarter": the crew chosen and the plan's first day
-- are kept on the plan, so a rebuild starts from them. A visit's month of the
-- quarter is carried beside its day, which a plan starting early makes
-- ambiguous.

-- AlterTable
ALTER TABLE "TbpQuarterPlan" ADD COLUMN     "crewTechnicianIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "maxLegMinutes" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "startsOn" DATE;

-- AlterTable
ALTER TABLE "TbpQuarterPlanStop" ADD COLUMN     "previousVisitMonth" INTEGER;
