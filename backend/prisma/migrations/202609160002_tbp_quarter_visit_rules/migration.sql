-- The office's rules for a quarter of benefit-package visits (2026-09-16).
--
-- Q2 and Q4 are HVAC inspections for tenancies on the HVAC plan and occupied
-- inspections for the rest, so a stop records which it is and why. A
-- technician-day is at most six hours inspecting and ninety minutes driving
-- between its properties, measured from the first one, so a day is laid out in
-- minutes rather than stops: the plan keeps the visit lengths and limits it was
-- routed with, a stop its own length, a day its time on site.
--
-- The Details come from the office's own sheet for the quarter, kept whole on
-- the plan so a regeneration matches it to the tenancies it adds.
--
-- FIRST_STOP is added and not used here: Postgres will not let a value added by
-- ALTER TYPE be used in the same transaction, and Prisma runs a migration in one.

-- AlterEnum
ALTER TYPE "PlanOriginKind" ADD VALUE 'FIRST_STOP';

-- AlterTable
ALTER TABLE "TbpQuarterPlan" ADD COLUMN     "holidays" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "hvacVisitMinutes" INTEGER NOT NULL DEFAULT 45,
ADD COLUMN     "maxDriveMinutes" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "maxOnSiteMinutes" INTEGER NOT NULL DEFAULT 360,
ADD COLUMN     "occupiedVisitMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "officeDetailsImportedAt" TIMESTAMP(3),
ADD COLUMN     "officeDetailsRows" JSONB;

-- AlterTable
ALTER TABLE "TbpQuarterPlanStop" ADD COLUMN     "inspectionType" "InspectionType" NOT NULL DEFAULT 'OCCUPIED',
ADD COLUMN     "inspectionTypeNeedsReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "inspectionTypeOverriddenAt" TIMESTAMP(3),
ADD COLUMN     "inspectionTypeReason" TEXT,
ADD COLUMN     "officeDetails" TEXT,
ADD COLUMN     "onSiteMinutes" INTEGER,
ADD COLUMN     "previousTechnicianId" UUID;

-- AlterTable
ALTER TABLE "TbpQuarterPlanDay" ADD COLUMN     "hvacStopCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "onSiteMinutes" INTEGER NOT NULL DEFAULT 0;

