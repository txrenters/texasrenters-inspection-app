-- Spatial markers for extracted property areas (normalized 0..1 coordinates tied
-- to a source floor-plan version). All columns nullable so existing approved
-- areas remain valid and keep their approval status.

ALTER TABLE "PropertyArea"
  ADD COLUMN "markerX" DECIMAL(6, 5),
  ADD COLUMN "markerY" DECIMAL(6, 5),
  ADD COLUMN "markerSource" TEXT,
  ADD COLUMN "markerConfidence" DECIMAL(4, 3),
  ADD COLUMN "markerUpdatedById" UUID,
  ADD COLUMN "markerUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "sourceFloorPlanId" UUID,
  ADD COLUMN "sourcePageNumber" INTEGER,
  ADD COLUMN "boundingBoxX" DECIMAL(6, 5),
  ADD COLUMN "boundingBoxY" DECIMAL(6, 5),
  ADD COLUMN "boundingBoxWidth" DECIMAL(6, 5),
  ADD COLUMN "boundingBoxHeight" DECIMAL(6, 5);

-- Normalized-coordinate range guards (NULL allowed).
ALTER TABLE "PropertyArea"
  ADD CONSTRAINT "PropertyArea_markerX_range" CHECK ("markerX" IS NULL OR ("markerX" >= 0 AND "markerX" <= 1)),
  ADD CONSTRAINT "PropertyArea_markerY_range" CHECK ("markerY" IS NULL OR ("markerY" >= 0 AND "markerY" <= 1)),
  ADD CONSTRAINT "PropertyArea_bboxX_range" CHECK ("boundingBoxX" IS NULL OR ("boundingBoxX" >= 0 AND "boundingBoxX" <= 1)),
  ADD CONSTRAINT "PropertyArea_bboxY_range" CHECK ("boundingBoxY" IS NULL OR ("boundingBoxY" >= 0 AND "boundingBoxY" <= 1)),
  ADD CONSTRAINT "PropertyArea_bboxW_range" CHECK ("boundingBoxWidth" IS NULL OR ("boundingBoxWidth" >= 0 AND "boundingBoxWidth" <= 1)),
  ADD CONSTRAINT "PropertyArea_bboxH_range" CHECK ("boundingBoxHeight" IS NULL OR ("boundingBoxHeight" >= 0 AND "boundingBoxHeight" <= 1));

CREATE INDEX "PropertyArea_sourceFloorPlanId_idx" ON "PropertyArea"("sourceFloorPlanId");

ALTER TABLE "PropertyArea"
  ADD CONSTRAINT "PropertyArea_markerUpdatedById_fkey"
  FOREIGN KEY ("markerUpdatedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PropertyArea"
  ADD CONSTRAINT "PropertyArea_sourceFloorPlanId_fkey"
  FOREIGN KEY ("sourceFloorPlanId") REFERENCES "PropertyFloorPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
