-- What kind of place a stop was: a hardware store, a convenience store, a gas
-- station (the office, 2026-11-04: "where did they stop, like hardwares,
-- convenient store including the name of the stores").
--
-- OpenStreetMap's own tag for the place, such as "shop=hardware", kept as it
-- came, so better wording later needs no second lookup. Null until it has been
-- asked; an empty string once OpenStreetMap was asked and had no business there.
-- It comes in the same free answer the name already does: no new provider and
-- no billed call.
--
-- Additive: one nullable column on a table whose tenant policy already covers it.

-- AlterTable
ALTER TABLE "TimeSegment" ADD COLUMN IF NOT EXISTS "placeCategory" TEXT;
