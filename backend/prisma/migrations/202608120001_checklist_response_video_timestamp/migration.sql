-- Seconds into the area's recording when a checklist item was answered.
--
-- Nullable, and deliberately not backfilled: assessments made before this
-- existed have no moment to point at, and inventing one would send a reviewer
-- to an arbitrary frame with the same confidence as a real answer.
ALTER TABLE "InspectionAreaChecklistResponse"
  ADD COLUMN "videoTimestampSeconds" INTEGER;
