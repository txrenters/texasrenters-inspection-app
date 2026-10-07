-- The room's recordings summarized for the report: the narration tidied into
-- its points with their moments, and what the room needs (repairs, painting,
-- cleaning). Written by the AI from the stored transcripts; null until then.
ALTER TABLE "InspectionArea"
  ADD COLUMN "recordingSummary" JSONB,
  ADD COLUMN "recordingSummaryAt" TIMESTAMP(3);
