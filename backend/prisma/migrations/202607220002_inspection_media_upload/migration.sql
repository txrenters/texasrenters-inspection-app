-- Room-video upload support for the DB-backed technician stack.
-- 1) Admin-scheduled inspections reference PropertywareBuilding rather than the
--    legacy Property model, so InspectionMedia.propertyId must be optional.
-- 2) Business rule: exactly one video per room. Registration replaces the
--    previous recording, and the unique index enforces the invariant.

ALTER TABLE "InspectionMedia" ALTER COLUMN "propertyId" DROP NOT NULL;

DROP INDEX IF EXISTS "InspectionMedia_inspectionAreaId_idx";
CREATE UNIQUE INDEX "InspectionMedia_inspectionAreaId_key" ON "InspectionMedia"("inspectionAreaId");
