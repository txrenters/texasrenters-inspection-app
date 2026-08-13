-- Links a photograph to the checklist item it evidences.
--
-- The office's printed report captions every photograph with the item it
-- documents — "WALLS & CEILINGS", "DOORS & LOCKS" — so the condition table
-- states the verdict and the photographs beneath it prove that verdict, item by
-- item. Without this column a photo can only carry free text, and the report
-- cannot group evidence under the row it belongs to.
--
-- NULLABLE on purpose: plenty of photographs document the room generally rather
-- than one item, and forcing a choice would push technicians into filing
-- overview shots under an arbitrary row.
--
-- ON DELETE SET NULL, not CASCADE: an administrator archiving or deleting a
-- checklist item must never delete the evidence captured against it. The photo
-- survives and simply stops being grouped.
ALTER TABLE "InspectionPhoto" ADD COLUMN "checklistItemId" UUID;

CREATE INDEX "InspectionPhoto_inspectionAreaId_checklistItemId_idx"
  ON "InspectionPhoto"("inspectionAreaId", "checklistItemId");

ALTER TABLE "InspectionPhoto"
  ADD CONSTRAINT "InspectionPhoto_checklistItemId_fkey"
  FOREIGN KEY ("checklistItemId") REFERENCES "AreaChecklistItem"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
