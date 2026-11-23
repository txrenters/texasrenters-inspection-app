-- Work orders go to the technician who fits the job.
--
-- 1. A grant carries how far the office trusts the person with the skill, from
--    the Technicians' Scope of Work sheet: FULL (a plain Y), LIMITED (a Y with a
--    limit, "MINOR REPAIRS ONLY") or NEEDS_IMPROVEMENT. Existing grants are FULL.
-- 2. `WorkOrderTriage` keeps the AI's reading of each work order (skills, minor
--    or major, confidence) and who was picked, or why nobody was. One row per
--    visit; the hash of the text read stops a re-send being read again.
--    SUGGESTED is the trial: the person who would have been assigned, named
--    and nobody actually assigned, notified or pushed to Jobber.

CREATE TYPE "TechnicianSkillLevel" AS ENUM ('FULL', 'LIMITED', 'NEEDS_IMPROVEMENT');

ALTER TABLE "TechnicianSkillGrant"
  ADD COLUMN "level" "TechnicianSkillLevel" NOT NULL DEFAULT 'FULL';

CREATE TYPE "WorkOrderTriageOutcome" AS ENUM (
  'ASSIGNED', 'SUGGESTED', 'ALREADY_ASSIGNED', 'NO_FIT', 'LOW_CONFIDENCE', 'AI_FAILED', 'DAILY_LIMIT', 'NOT_CONFIGURED'
);

CREATE TABLE "WorkOrderTriage" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "inspectionId" UUID NOT NULL,
  "inputHash" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "outcome" "WorkOrderTriageOutcome" NOT NULL,
  "skillKeys" TEXT[],
  "scope" TEXT,
  "confidence" INTEGER,
  "summary" TEXT,
  "reason" TEXT NOT NULL,
  "technicianId" UUID,
  "ranking" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkOrderTriage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkOrderTriage_scope_check" CHECK ("scope" IS NULL OR "scope" IN ('MINOR', 'MAJOR')),
  CONSTRAINT "WorkOrderTriage_confidence_check" CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 100),
  -- Only an assignment, or the trial's would-be assignment, names a technician.
  CONSTRAINT "WorkOrderTriage_technician_check" CHECK (("outcome" IN ('ASSIGNED', 'SUGGESTED')) = ("technicianId" IS NOT NULL))
);

CREATE UNIQUE INDEX "WorkOrderTriage_inspectionId_key" ON "WorkOrderTriage"("inspectionId");
CREATE INDEX "WorkOrderTriage_organizationId_outcome_idx" ON "WorkOrderTriage"("organizationId", "outcome");

ALTER TABLE "WorkOrderTriage" ADD CONSTRAINT "WorkOrderTriage_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkOrderTriage" ADD CONSTRAINT "WorkOrderTriage_inspectionId_fkey"
  FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkOrderTriage" ADD CONSTRAINT "WorkOrderTriage_technicianId_fkey"
  FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkOrderTriage" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "WorkOrderTriage"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
