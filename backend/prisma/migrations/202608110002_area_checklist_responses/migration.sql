-- Per-inspection assessment of each checklist item.
--
-- Three axes plus a comment, mirroring the printed report the office already
-- issues: every row is scored Clean / Undamaged / Working.
--
-- The booleans are NULLABLE on purpose. The existing reports leave rows blank,
-- and "not assessed" is a different claim from "No" — collapsing them would
-- invent findings nobody made. The report renders a blank cell for NULL.
--
-- Keyed to InspectionArea, not PropertyArea: the same room is assessed again at
-- every inspection, and last quarter's answers must not surface as this
-- quarter's.

-- CreateTable
CREATE TABLE "InspectionAreaChecklistResponse" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "inspectionAreaId" UUID NOT NULL,
    "checklistItemId" UUID NOT NULL,
    "isClean" BOOLEAN,
    "isUndamaged" BOOLEAN,
    "isWorking" BOOLEAN,
    "comment" TEXT,
    "recordedById" UUID,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionAreaChecklistResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InspectionAreaChecklistResponse_inspectionAreaId_idx" ON "InspectionAreaChecklistResponse"("inspectionAreaId");

-- CreateIndex
CREATE INDEX "InspectionAreaChecklistResponse_organizationId_idx" ON "InspectionAreaChecklistResponse"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionAreaChecklistResponse_inspectionAreaId_checklistI_key" ON "InspectionAreaChecklistResponse"("inspectionAreaId", "checklistItemId");

-- AddForeignKey
ALTER TABLE "InspectionAreaChecklistResponse" ADD CONSTRAINT "InspectionAreaChecklistResponse_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionAreaChecklistResponse" ADD CONSTRAINT "InspectionAreaChecklistResponse_inspectionAreaId_fkey" FOREIGN KEY ("inspectionAreaId") REFERENCES "InspectionArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionAreaChecklistResponse" ADD CONSTRAINT "InspectionAreaChecklistResponse_checklistItemId_fkey" FOREIGN KEY ("checklistItemId") REFERENCES "AreaChecklistItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

