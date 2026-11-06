-- What the office writes on a job (2026-11-07, phase 4 of the job page review):
-- "office can also make their own internal notes". Until now that was one
-- field, `Inspection.internalNotes`, mostly filled by the system ("Booked from
-- Propertyware"), shown on the technician's phone, and locked once a job was
-- submitted. A note here says who wrote it and when, can be added at any time,
-- and stays off the phone unless its author ticks "Show to technician".
-- `internalNotes` stays as it is: the page reads it as the booking note.
-- Additive.

CREATE TABLE "InspectionNote" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "visibleToTechnician" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "InspectionNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InspectionNote_inspectionId_createdAt_idx" ON "InspectionNote"("inspectionId", "createdAt");
CREATE INDEX "InspectionNote_organizationId_idx" ON "InspectionNote"("organizationId");
CREATE INDEX "InspectionNote_createdById_idx" ON "InspectionNote"("createdById");

ALTER TABLE "InspectionNote" ADD CONSTRAINT "InspectionNote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InspectionNote" ADD CONSTRAINT "InspectionNote_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InspectionNote" ADD CONSTRAINT "InspectionNote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- As `MAX_OFFICE_NOTE` has it, and never only spaces.
ALTER TABLE "InspectionNote" ADD CONSTRAINT "InspectionNote_text_known" CHECK (
  length(btrim("text")) > 0 AND length("text") <= 2000
);

ALTER TABLE "InspectionNote" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "InspectionNote"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
