-- Coordinates on the synced building record.
--
-- The console's property list reads propertyware_buildings; its map read the
-- Property table. Those are different sets -- 570 against 9 -- so the map had
-- never agreed with the page beside it. Putting the coordinate here lets both
-- answer from one table, and lets the Propertyware sync alone decide what
-- exists: deactivate a building and it leaves the map, add one and it joins.
ALTER TABLE "propertyware_buildings"
  ADD COLUMN "latitude"         DECIMAL(9, 6),
  ADD COLUMN "longitude"        DECIMAL(9, 6),
  ADD COLUMN "geocodedFor"      TEXT,
  ADD COLUMN "geocodedAt"       TIMESTAMP(3),
  ADD COLUMN "geocodeSource"    TEXT,
  ADD COLUMN "geocodePrecision" TEXT;

-- The scheduler asks only "what still needs looking up", and after the first
-- backfill that answer is almost always empty -- so a partial index, paid for
-- only by the rows that qualify.
CREATE INDEX "propertyware_buildings_pending_geocode_idx"
  ON "propertyware_buildings" ("organizationId")
  WHERE "latitude" IS NULL AND "isActive";
