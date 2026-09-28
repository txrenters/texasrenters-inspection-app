-- Zones a quarter is built without.
--
-- The office works zones 1 to 4 and arranges zone 5 by hand, and until now
-- that was done by deleting the visits afterwards. Recorded on the plan so a
-- rebuild keeps the same rule rather than pulling them back in, and so the
-- quarter can say which visits were held back deliberately -- a different
-- thing from a visit the planner could not place.

-- AlterTable
ALTER TABLE "TbpQuarterPlan"
  ADD COLUMN IF NOT EXISTS "excludedZones" TEXT[] DEFAULT ARRAY[]::TEXT[];
