-- A Jobber visit that books two inspections (2026-10-13): "Q4 Filter Drop +
-- HVAC Inspection + Occupied inspection" is two jobs, and the office wants
-- both. `Inspection.jobberVisitId` stays one inspection per visit -- every
-- push, completion and removal is keyed on it -- so the second inspection is
-- a companion of the first: no visit of its own, and it follows that one.
--
-- Additive: null on every existing inspection. SET NULL on delete, so removing
-- the inspection a companion follows leaves the companion as an ordinary one.
ALTER TABLE "Inspection" ADD COLUMN "jobberCompanionOfId" UUID;

CREATE INDEX "Inspection_jobberCompanionOfId_idx" ON "Inspection"("jobberCompanionOfId");

ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_jobberCompanionOfId_fkey" FOREIGN KEY ("jobberCompanionOfId") REFERENCES "Inspection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
