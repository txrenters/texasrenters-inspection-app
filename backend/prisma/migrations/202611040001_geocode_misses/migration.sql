-- The address no geocoder could place, and when it was last tried.
--
-- The hourly geocoding pass asked about every row without a coordinate, and
-- recorded nothing when the answer was "no match" -- so an address Google
-- cannot place was a billed lookup every hour for ever, up to 250 rows a pass.
-- The pass now writes the miss down with the address it was for, and skips the
-- row until that address changes or the back-off passes.
--
-- Additive: nullable columns on two existing tables whose tenant policies
-- already cover them.

-- AlterTable
ALTER TABLE "Property"
  ADD COLUMN IF NOT EXISTS "geocodeMissFor" TEXT,
  ADD COLUMN IF NOT EXISTS "geocodeMissAt"  TIMESTAMP(3);

-- AlterTable
ALTER TABLE "propertyware_buildings"
  ADD COLUMN IF NOT EXISTS "geocodeMissFor" TEXT,
  ADD COLUMN IF NOT EXISTS "geocodeMissAt"  TIMESTAMP(3);
