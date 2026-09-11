-- What scheduling needs to know about a technician, and what a published
-- quarter was forecast to cost.
--
-- `TechnicianPlanningProfile` is separate from `UserProfile` because it is
-- planning policy rather than identity: a coordinator sets it, it changes
-- without the person changing, and a technician with no row is still a valid
-- technician who simply takes the defaults. `isPlannable` is distinct from
-- deactivating the account, which would also take away their handset.
--
-- `TbpQuarterPlanDay` is frozen at publish and never recomputed. A forecast you
-- can recompute is not a forecast: comparing it with what happened would only
-- ever compare today's traffic model against itself.
--
-- `durationSource` is nullable and that is load-bearing. No routing available is
-- a different fact from a drive of zero seconds, and a report that quietly
-- mixed traffic-aware, free-flow and straight-line numbers would be worse than
-- one with visible gaps.

-- CreateEnum
CREATE TYPE "PlanOriginKind" AS ENUM ('HOME', 'INFERRED', 'CLUSTER_CENTROID');

-- CreateEnum
CREATE TYPE "DriveTimeSource" AS ENUM ('GOOGLE_TRAFFIC_AWARE', 'OSRM_FREE_FLOW', 'HAVERSINE');

-- AlterTable
ALTER TABLE "TbpQuarterPlanStop" ADD COLUMN     "positionInDay" INTEGER;

-- CreateTable
CREATE TABLE "TechnicianPlanningProfile" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "technicianId" UUID NOT NULL,
    "homeLatitude" DECIMAL(9,6),
    "homeLongitude" DECIMAL(9,6),
    "homeGeocodedFor" TEXT,
    "homeOriginKind" "PlanOriginKind" NOT NULL DEFAULT 'HOME',
    "dailyStopCap" INTEGER NOT NULL DEFAULT 10,
    "isPlannable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TechnicianPlanningProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TbpQuarterPlanDay" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "technicianId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "stopCount" INTEGER NOT NULL,
    "totalDriveSeconds" INTEGER,
    "totalDriveMeters" INTEGER,
    "originLatitude" DECIMAL(9,6),
    "originLongitude" DECIMAL(9,6),
    "originKind" "PlanOriginKind" NOT NULL DEFAULT 'CLUSTER_CENTROID',
    "durationSource" "DriveTimeSource",
    "departureAssumedAt" TIMESTAMP(3),
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TbpQuarterPlanDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TechnicianPlanningProfile_technicianId_key" ON "TechnicianPlanningProfile"("technicianId");

-- CreateIndex
CREATE INDEX "TechnicianPlanningProfile_organizationId_isPlannable_idx" ON "TechnicianPlanningProfile"("organizationId", "isPlannable");

-- CreateIndex
CREATE INDEX "TbpQuarterPlanDay_organizationId_date_idx" ON "TbpQuarterPlanDay"("organizationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "TbpQuarterPlanDay_planId_technicianId_date_key" ON "TbpQuarterPlanDay"("planId", "technicianId", "date");

-- AddForeignKey
ALTER TABLE "TechnicianPlanningProfile" ADD CONSTRAINT "TechnicianPlanningProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicianPlanningProfile" ADD CONSTRAINT "TechnicianPlanningProfile_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TbpQuarterPlanDay" ADD CONSTRAINT "TbpQuarterPlanDay_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TbpQuarterPlanDay" ADD CONSTRAINT "TbpQuarterPlanDay_planId_fkey" FOREIGN KEY ("planId") REFERENCES "TbpQuarterPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TbpQuarterPlanDay" ADD CONSTRAINT "TbpQuarterPlanDay_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant isolation, as on every other table here. A missing policy is
-- invisible: nothing errors, the rows are simply readable by the wrong
-- organization.
ALTER TABLE "TechnicianPlanningProfile" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "TechnicianPlanningProfile"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "TbpQuarterPlanDay" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "TbpQuarterPlanDay"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

-- A day cannot hold a negative number of stops, and a cap of zero would mean a
-- technician who is plannable but can never be planned -- `isPlannable` is how
-- to say that, so this rejects the contradiction rather than scheduling nothing
-- and reporting a capacity shortfall nobody can explain.
ALTER TABLE "TechnicianPlanningProfile"
  ADD CONSTRAINT "TechnicianPlanningProfile_dailyStopCap_positive"
  CHECK ("dailyStopCap" >= 1);

ALTER TABLE "TbpQuarterPlanDay"
  ADD CONSTRAINT "TbpQuarterPlanDay_stopCount_nonnegative"
  CHECK ("stopCount" >= 0);

-- A stop's position within a day is 1-based; a 0 means the sequencing pass lost
-- one.
ALTER TABLE "TbpQuarterPlanStop"
  ADD CONSTRAINT "TbpQuarterPlanStop_positionInDay_positive"
  CHECK ("positionInDay" IS NULL OR "positionInDay" >= 1);
