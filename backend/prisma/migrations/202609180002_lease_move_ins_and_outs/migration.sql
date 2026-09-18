-- Move-outs and move-ins booked from Propertyware's leases (the office, 2026-09-18).
--
-- Every lease gets a move-out sixty days before its tenancy ends, and a tenant
-- who is leaving a move-in twenty-two days after they go -- booked here, not in
-- Jobber, which the office is leaving. `LeaseScheduledInspection` records what
-- each lease's rule produced, one row per lease and kind, so a daily run books
-- each once and moves or calls it off when the lease's dates change.
-- `handlesMoveIns` marks who takes the move-ins, as `handlesMoveOuts` does the
-- move-outs.

-- CreateEnum
CREATE TYPE "LeaseInspectionOutcome" AS ENUM ('SCHEDULED', 'ALREADY_BOOKED', 'NEEDS_UNIT', 'NOT_BOOKABLE', 'CALLED_OFF', 'CANCELLED');

-- AlterTable
ALTER TABLE "TechnicianPlanningProfile" ADD COLUMN     "handlesMoveIns" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "LeaseScheduledInspection" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "leaseId" UUID NOT NULL,
    "inspectionType" "InspectionType" NOT NULL,
    "dueOn" DATE NOT NULL,
    "scheduledOn" DATE NOT NULL,
    "outcome" "LeaseInspectionOutcome" NOT NULL,
    "inspectionId" UUID,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaseScheduledInspection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeaseScheduledInspection_organizationId_outcome_scheduledOn_idx" ON "LeaseScheduledInspection"("organizationId", "outcome", "scheduledOn");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseScheduledInspection_leaseId_inspectionType_key" ON "LeaseScheduledInspection"("leaseId", "inspectionType");

-- AddForeignKey
ALTER TABLE "LeaseScheduledInspection" ADD CONSTRAINT "LeaseScheduledInspection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaseScheduledInspection" ADD CONSTRAINT "LeaseScheduledInspection_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "propertyware_leases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaseScheduledInspection" ADD CONSTRAINT "LeaseScheduledInspection_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant isolation, as on every other organization's table. A missing policy is
-- invisible: nothing errors, the rows are simply readable by the wrong
-- organization.
ALTER TABLE "LeaseScheduledInspection" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "LeaseScheduledInspection"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
