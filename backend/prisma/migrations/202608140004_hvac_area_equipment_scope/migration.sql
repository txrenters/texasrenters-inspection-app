-- HVAC inspections are scoped by equipment, not by an operator picking areas.
--
-- An HVAC visit covers every approved area of the property that actually has an
-- air conditioner, so the database has to be able to answer "which areas have
-- one". It could not: PropertyArea recorded name, category, environment, floor
-- and marker geometry, and nothing about equipment.
--
-- Both changes are additive with defaults that preserve current behaviour.

-- Which areas hold air-conditioning equipment.
--
-- Defaults false rather than true: an existing property then scopes an HVAC
-- visit to nothing until somebody records where the units are, which fails
-- visibly. Defaulting true would silently send a technician to look for an air
-- conditioner in every bathroom and closet on the property.
-- No index on this column. The lookup it serves is "approved areas of THIS
-- property that have one", already narrowed by propertyId to a handful of rows,
-- and Prisma cannot declare a partial index in the schema — adding one only in
-- SQL would leave the schema and the database disagreeing, which is exactly the
-- drift that makes the next `migrate diff` unreadable here.
ALTER TABLE "PropertyArea"
  ADD COLUMN IF NOT EXISTS "hasAirConditioning" BOOLEAN NOT NULL DEFAULT false;

-- What kind of visit a checklist item is written for.
--
-- Items are stored per area, but an area is walked differently depending on the
-- visit: a move-in asks about its floor and walls, an HVAC visit asks about the
-- air conditioner in it. InspectionAreaChecklistResponse points at a persisted
-- item row, so both sets must coexist on the area rather than one being
-- generated on the fly.
DO $$
BEGIN
  CREATE TYPE "AreaChecklistItemKind" AS ENUM ('ROOM', 'AIR_CONDITIONING');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE "AreaChecklistItem"
  ADD COLUMN IF NOT EXISTS "kind" "AreaChecklistItemKind" NOT NULL DEFAULT 'ROOM';

-- Widen the uniqueness to include the kind.
--
-- The same wording twice in one area of the same kind is still a mistake; the
-- same wording across kinds is legitimate, since an area can reasonably be asked
-- about its vents as part of the room and again as part of the air conditioner.
--
-- This cannot fail on existing data. Every current row is ROOM, so
-- (area, ROOM, label) is unique exactly when (area, label) was.
ALTER TABLE "AreaChecklistItem"
  DROP CONSTRAINT IF EXISTS "AreaChecklistItem_propertyAreaId_label_key";

DROP INDEX IF EXISTS "AreaChecklistItem_propertyAreaId_label_key";

CREATE UNIQUE INDEX IF NOT EXISTS "AreaChecklistItem_propertyAreaId_kind_label_key"
  ON "AreaChecklistItem" ("propertyAreaId", "kind", "label");
