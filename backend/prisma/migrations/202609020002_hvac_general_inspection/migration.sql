-- HVAC becomes a general inspection of the property's system rather than a walk
-- of every room flagged as holding a unit.
--
-- The old model needed an approved floor plan AND somebody to tick
-- `hasAirConditioning` on the right areas of every property. The flag was set on
-- one area in the entire database, so every HVAC inspection created covered
-- nothing and reached the technician empty.

-- The HVAC checklist is one standard list about the equipment, identical on
-- every property. Storing it per area would mean copying it across the whole
-- portfolio and keeping every copy in step.
ALTER TABLE "AreaChecklistItem" ALTER COLUMN "propertyAreaId" DROP NOT NULL;

-- The table's own @@unique([propertyAreaId, kind, label]) does not constrain the
-- organization-wide rows: Postgres treats NULLs as distinct, so it would admit
-- the same label any number of times. Prisma cannot express a partial index, so
-- this is raw.
CREATE UNIQUE INDEX "AreaChecklistItem_org_wide_kind_label_key"
  ON "AreaChecklistItem" ("organizationId", "kind", "label")
  WHERE "propertyAreaId" IS NULL;

-- Nothing reads this any more. One row in the database had it set.
ALTER TABLE "PropertyArea" DROP COLUMN "hasAirConditioning";
