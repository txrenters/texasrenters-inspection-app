-- The benefit-package crew, and the order its zones go round (the office, 2026-09-16).
--
-- Moses, Kevin and Emanuel take the quarter's benefit-package visits, both
-- kinds, one zone a week each, and all move one zone on each week. A planning
-- profile's place in that rotation says who is on the crew; null is not on it.
-- Days measured from here on also count the drive from home in their drive
-- limit, which needs no column: `totalDriveSeconds` carries it.

-- AlterTable
ALTER TABLE "TechnicianPlanningProfile" ADD COLUMN     "tbpZoneOrder" INTEGER;
