-- Coordinates for a property, derived from its address by a geocoder.
--
-- Nullable throughout and added without a default: every existing row is
-- simply "not looked up yet", which is exactly what null means here. No
-- backfill runs in this migration -- geocoding talks to an external service
-- and a migration must not depend on the network.
ALTER TABLE "Property"
  ADD COLUMN "latitude"         DECIMAL(9, 6),
  ADD COLUMN "longitude"        DECIMAL(9, 6),
  ADD COLUMN "geocodedFor"      TEXT,
  ADD COLUMN "geocodedAt"       TIMESTAMP(3),
  ADD COLUMN "geocodeSource"    TEXT,
  ADD COLUMN "geocodePrecision" TEXT;

-- The scheduler's only question is "what still needs looking up", so the index
-- covers exactly that: rows within one organization that have no coordinate.
-- Partial, because once the backfill is done the answer is almost always empty
-- and a full index would be paid for on every write for nothing.
CREATE INDEX "Property_pending_geocode_idx"
  ON "Property" ("organizationId")
  WHERE "latitude" IS NULL;
