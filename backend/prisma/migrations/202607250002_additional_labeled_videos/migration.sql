-- Additional labeled videos: keep one PRIMARY_AREA video per area, allow extras.
CREATE TYPE "VideoRecordingType" AS ENUM ('PRIMARY_AREA', 'ADDITIONAL_ISSUE');

ALTER TABLE "InspectionMedia"
  ADD COLUMN "recordingType" "VideoRecordingType" NOT NULL DEFAULT 'PRIMARY_AREA',
  ADD COLUMN "label" TEXT,
  ADD COLUMN "category" TEXT,
  ADD COLUMN "relatedFindingId" UUID,
  ADD COLUMN "captureGuidelineVersion" TEXT;

-- Replace the strict one-media-per-area constraint with one PRIMARY_AREA per area.
ALTER TABLE "InspectionMedia" DROP CONSTRAINT IF EXISTS "InspectionMedia_inspectionAreaId_key";
DROP INDEX IF EXISTS "InspectionMedia_inspectionAreaId_key";
CREATE UNIQUE INDEX "InspectionMedia_primary_area_key"
  ON "InspectionMedia" ("inspectionAreaId")
  WHERE "recordingType" = 'PRIMARY_AREA';
CREATE INDEX "InspectionMedia_inspectionAreaId_idx" ON "InspectionMedia" ("inspectionAreaId");

ALTER TABLE "InspectionMedia"
  ADD CONSTRAINT "InspectionMedia_relatedFindingId_fkey"
  FOREIGN KEY ("relatedFindingId") REFERENCES "InspectionFinding" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
