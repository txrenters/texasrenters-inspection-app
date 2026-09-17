-- Move-outs anchor the benefit-package days (the office, 2026-09-17).
--
-- Move-outs are Moses's, and on a day he has one his benefit-package visits
-- are the ones nearest it, from any zone. `handlesMoveOuts` marks whose days
-- move-outs anchor (nobody, until it is set). The plan records each move-out
-- it built a day around, with its place in that day's route; the move-out is
-- its own inspection and is never published from the plan.

-- AlterTable
ALTER TABLE "TechnicianPlanningProfile" ADD COLUMN     "handlesMoveOuts" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TbpQuarterPlanAnchor" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "technicianId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "onSiteMinutes" INTEGER NOT NULL DEFAULT 60,
    "positionInDay" INTEGER,
    "driveSecondsForecast" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TbpQuarterPlanAnchor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TbpQuarterPlanAnchor_planId_technicianId_date_idx" ON "TbpQuarterPlanAnchor"("planId", "technicianId", "date");

-- CreateIndex
CREATE INDEX "TbpQuarterPlanAnchor_organizationId_date_idx" ON "TbpQuarterPlanAnchor"("organizationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "TbpQuarterPlanAnchor_planId_inspectionId_key" ON "TbpQuarterPlanAnchor"("planId", "inspectionId");

-- AddForeignKey
ALTER TABLE "TbpQuarterPlanAnchor" ADD CONSTRAINT "TbpQuarterPlanAnchor_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TbpQuarterPlanAnchor" ADD CONSTRAINT "TbpQuarterPlanAnchor_planId_fkey" FOREIGN KEY ("planId") REFERENCES "TbpQuarterPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TbpQuarterPlanAnchor" ADD CONSTRAINT "TbpQuarterPlanAnchor_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TbpQuarterPlanAnchor" ADD CONSTRAINT "TbpQuarterPlanAnchor_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, as on every other plan table. A missing policy is invisible:
-- nothing errors, the rows are simply readable by the wrong organization.
ALTER TABLE "TbpQuarterPlanAnchor" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "TbpQuarterPlanAnchor"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

-- An hour is the office's; nothing is on site for no time or a negative one.
ALTER TABLE "TbpQuarterPlanAnchor"
  ADD CONSTRAINT "TbpQuarterPlanAnchor_onSiteMinutes_positive"
  CHECK ("onSiteMinutes" > 0);
