-- What each planned day was measured from.
--
-- A quarter Rebuild measured every crew-day again on Mapbox -- one matrix of
-- the office and the day's stops each, a hundred elements for a nine-stop day,
-- close to five thousand for Q4 2026's 431 visits -- whether or not the day
-- had changed.
-- The day now keeps a key of what it was measured from (where it starts, the
-- longest leg its order allows, each stop and where it is), and a Rebuild
-- reuses the measurement of a day whose key is unchanged.
--
-- Additive: one nullable column on a table whose tenant policy already covers
-- it. Days measured before it are measured once more.

-- AlterTable
ALTER TABLE "TbpQuarterPlanDay"
  ADD COLUMN IF NOT EXISTS "measuredFor" TEXT;
