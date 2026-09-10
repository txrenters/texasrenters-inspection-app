-- A quarter's benefit-package inspections, before they are real.
--
-- The plan is its own table rather than several hundred `Inspection` rows, and
-- that is not a preference. `InspectionStatus` has no draft state; `SCHEDULED`
-- means "booked" to the technician's handset; and
-- `Inspection_scheduled_booking_key` -- the partial unique index added in
-- 202608310006 -- rejects two SCHEDULED rows for the same unit on the same day,
-- which every re-solve that moves a stop to another date would collide with.
--
-- `TbpQuarterPlanStop.sequence` is deliberately NOT unique. Postgres checks a
-- non-deferrable unique index per row, so swapping two stops in one statement
-- -- which is what a drag in the console is -- fails on the swap. Contiguity is
-- asserted in application code at publish instead.
--
-- `inspectionId` IS unique, and nulls do not collide in Postgres, so every
-- unpublished stop across every quarter coexists while a published one can
-- never be minted twice. That is what lets a half-finished publish resume by
-- selecting `inspectionId IS NULL`.
--
-- Every foreign key out to something a person can delete is ON DELETE SET NULL,
-- not CASCADE. `inspections:delete` hard-deletes an inspection and its media;
-- erasing the record that a quarter planned it would take the explanation away
-- with the evidence.

-- CreateEnum
CREATE TYPE "TbpPlanStatus" AS ENUM ('DRAFT', 'PUBLISHING', 'PUBLISHED', 'PUBLISH_FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TbpStopStatus" AS ENUM ('PLANNED', 'BLOCKED', 'EXCLUDED', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "TbpOrderSource" AS ENUM ('PRIOR_QUARTER', 'CARRIED_SKIP', 'NEW_ENROLLMENT');

-- CreateEnum
CREATE TYPE "TbpUnitResolution" AS ENUM ('NO_UNITS', 'LEASE_MATCH', 'SOLE_UNIT', 'PRIOR_INSPECTION', 'MANUAL', 'UNRESOLVED');

-- CreateTable
CREATE TABLE "TbpQuarterPlan" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "quarterYear" INTEGER NOT NULL,
    "quarterNumber" INTEGER NOT NULL,
    "quarterStartsOn" DATE NOT NULL,
    "status" "TbpPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "generationRunId" TEXT NOT NULL,
    "randomSeed" INTEGER NOT NULL,
    "plannerVersion" INTEGER NOT NULL DEFAULT 1,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stopCount" INTEGER NOT NULL DEFAULT 0,
    "blockedCount" INTEGER NOT NULL DEFAULT 0,
    "publishedCount" INTEGER NOT NULL DEFAULT 0,
    "unverifiedEnrollmentCount" INTEGER NOT NULL DEFAULT 0,
    "publishStartedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "publishedById" UUID,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TbpQuarterPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TbpQuarterPlanStop" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "propertywareTenantId" UUID NOT NULL,
    "tenantExternalId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "previousSequence" INTEGER,
    "orderSource" "TbpOrderSource" NOT NULL,
    "zone" TEXT,
    "propertywareBuildingId" UUID,
    "propertywareUnitId" UUID,
    "propertywareLeaseId" UUID,
    "unitResolution" "TbpUnitResolution" NOT NULL DEFAULT 'UNRESOLVED',
    "scheduledOn" DATE,
    "assignedTechnicianId" UUID,
    "driveSecondsForecast" INTEGER,
    "status" "TbpStopStatus" NOT NULL DEFAULT 'PLANNED',
    "blockedCode" TEXT,
    "blockedMessage" TEXT,
    "inspectionId" UUID,
    "jobberVisitId" TEXT,
    "jobberJobId" TEXT,
    "hvacFilterSizes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "visitTitle" TEXT,
    "visitDetails" TEXT,
    "sequenceOverriddenAt" TIMESTAMP(3),
    "scheduleOverriddenAt" TIMESTAMP(3),
    "technicianOverriddenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TbpQuarterPlanStop_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TbpQuarterPlan_organizationId_status_idx" ON "TbpQuarterPlan"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TbpQuarterPlan_organizationId_quarterYear_quarterNumber_key" ON "TbpQuarterPlan"("organizationId", "quarterYear", "quarterNumber");

-- CreateIndex
CREATE UNIQUE INDEX "TbpQuarterPlanStop_inspectionId_key" ON "TbpQuarterPlanStop"("inspectionId");

-- CreateIndex
CREATE INDEX "TbpQuarterPlanStop_planId_sequence_idx" ON "TbpQuarterPlanStop"("planId", "sequence");

-- CreateIndex
CREATE INDEX "TbpQuarterPlanStop_planId_status_idx" ON "TbpQuarterPlanStop"("planId", "status");

-- CreateIndex
CREATE INDEX "TbpQuarterPlanStop_organizationId_scheduledOn_assignedTechn_idx" ON "TbpQuarterPlanStop"("organizationId", "scheduledOn", "assignedTechnicianId");

-- CreateIndex
CREATE UNIQUE INDEX "TbpQuarterPlanStop_planId_propertywareTenantId_key" ON "TbpQuarterPlanStop"("planId", "propertywareTenantId");

-- AddForeignKey
ALTER TABLE "TbpQuarterPlan" ADD CONSTRAINT "TbpQuarterPlan_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TbpQuarterPlan" ADD CONSTRAINT "TbpQuarterPlan_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TbpQuarterPlanStop" ADD CONSTRAINT "TbpQuarterPlanStop_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TbpQuarterPlanStop" ADD CONSTRAINT "TbpQuarterPlanStop_planId_fkey" FOREIGN KEY ("planId") REFERENCES "TbpQuarterPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TbpQuarterPlanStop" ADD CONSTRAINT "TbpQuarterPlanStop_propertywareTenantId_fkey" FOREIGN KEY ("propertywareTenantId") REFERENCES "PropertywareTenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TbpQuarterPlanStop" ADD CONSTRAINT "TbpQuarterPlanStop_propertywareBuildingId_fkey" FOREIGN KEY ("propertywareBuildingId") REFERENCES "propertyware_buildings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TbpQuarterPlanStop" ADD CONSTRAINT "TbpQuarterPlanStop_propertywareUnitId_fkey" FOREIGN KEY ("propertywareUnitId") REFERENCES "propertyware_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TbpQuarterPlanStop" ADD CONSTRAINT "TbpQuarterPlanStop_propertywareLeaseId_fkey" FOREIGN KEY ("propertywareLeaseId") REFERENCES "propertyware_leases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TbpQuarterPlanStop" ADD CONSTRAINT "TbpQuarterPlanStop_assignedTechnicianId_fkey" FOREIGN KEY ("assignedTechnicianId") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TbpQuarterPlanStop" ADD CONSTRAINT "TbpQuarterPlanStop_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Tenant isolation. A missing policy here is invisible: nothing errors, the
-- rows are simply readable by the wrong organization.
--
-- The `'*'` escape is what lets a maintenance script on the owner connection
-- see across organizations.
ALTER TABLE "TbpQuarterPlan" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "TbpQuarterPlan"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "TbpQuarterPlanStop" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "TbpQuarterPlanStop"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

-- A quarter number is 1-4 and a plan cannot claim to be the fifth.
--
-- In the database rather than only in the DTO because the cron writes these
-- without passing through a controller, and the arithmetic that derives them
-- from a date is exactly the kind that produces a 0 or a 5 at a year boundary.
ALTER TABLE "TbpQuarterPlan"
  ADD CONSTRAINT "TbpQuarterPlan_quarterNumber_range"
  CHECK ("quarterNumber" BETWEEN 1 AND 4);

-- A stop's position is 1-based. A 0 means the ranking code lost a stop.
ALTER TABLE "TbpQuarterPlanStop"
  ADD CONSTRAINT "TbpQuarterPlanStop_sequence_positive"
  CHECK ("sequence" >= 1);
