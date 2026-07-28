-- Supabase mirror of Prisma migration 202607250006_area_spatial_markers.
-- Spatial markers for extracted property areas (normalized 0..1, tied to a
-- source floor-plan version). All columns nullable — existing areas stay valid.

ALTER TABLE "PropertyArea"
  ADD COLUMN IF NOT EXISTS "markerX" DECIMAL(6, 5),
  ADD COLUMN IF NOT EXISTS "markerY" DECIMAL(6, 5),
  ADD COLUMN IF NOT EXISTS "markerSource" TEXT,
  ADD COLUMN IF NOT EXISTS "markerConfidence" DECIMAL(4, 3),
  ADD COLUMN IF NOT EXISTS "markerUpdatedById" UUID,
  ADD COLUMN IF NOT EXISTS "markerUpdatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sourceFloorPlanId" UUID,
  ADD COLUMN IF NOT EXISTS "sourcePageNumber" INTEGER,
  ADD COLUMN IF NOT EXISTS "boundingBoxX" DECIMAL(6, 5),
  ADD COLUMN IF NOT EXISTS "boundingBoxY" DECIMAL(6, 5),
  ADD COLUMN IF NOT EXISTS "boundingBoxWidth" DECIMAL(6, 5),
  ADD COLUMN IF NOT EXISTS "boundingBoxHeight" DECIMAL(6, 5);

DO $$ BEGIN
  ALTER TABLE "PropertyArea"
    ADD CONSTRAINT "PropertyArea_markerX_range" CHECK ("markerX" IS NULL OR ("markerX" >= 0 AND "markerX" <= 1)),
    ADD CONSTRAINT "PropertyArea_markerY_range" CHECK ("markerY" IS NULL OR ("markerY" >= 0 AND "markerY" <= 1)),
    ADD CONSTRAINT "PropertyArea_bboxX_range" CHECK ("boundingBoxX" IS NULL OR ("boundingBoxX" >= 0 AND "boundingBoxX" <= 1)),
    ADD CONSTRAINT "PropertyArea_bboxY_range" CHECK ("boundingBoxY" IS NULL OR ("boundingBoxY" >= 0 AND "boundingBoxY" <= 1)),
    ADD CONSTRAINT "PropertyArea_bboxW_range" CHECK ("boundingBoxWidth" IS NULL OR ("boundingBoxWidth" >= 0 AND "boundingBoxWidth" <= 1)),
    ADD CONSTRAINT "PropertyArea_bboxH_range" CHECK ("boundingBoxHeight" IS NULL OR ("boundingBoxHeight" >= 0 AND "boundingBoxHeight" <= 1));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "PropertyArea_sourceFloorPlanId_idx" ON "PropertyArea"("sourceFloorPlanId");

DO $$ BEGIN
  ALTER TABLE "PropertyArea"
    ADD CONSTRAINT "PropertyArea_markerUpdatedById_fkey"
    FOREIGN KEY ("markerUpdatedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "PropertyArea"
    ADD CONSTRAINT "PropertyArea_sourceFloorPlanId_fkey"
    FOREIGN KEY ("sourceFloorPlanId") REFERENCES "PropertyFloorPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
