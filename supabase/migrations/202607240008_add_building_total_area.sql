-- Mirror of Prisma migration 202607240002_add_building_total_area.
-- Verified Propertyware building area fields plus administrator manual override.
ALTER TABLE "propertyware_buildings"
  ADD COLUMN IF NOT EXISTS "totalArea" INTEGER,
  ADD COLUMN IF NOT EXISTS "areaUnits" TEXT,
  ADD COLUMN IF NOT EXISTS "category" TEXT,
  ADD COLUMN IF NOT EXISTS "manualTotalArea" INTEGER,
  ADD COLUMN IF NOT EXISTS "manualAreaUnit" TEXT;
