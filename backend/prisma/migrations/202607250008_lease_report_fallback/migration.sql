-- Leases sourced from the published Propertyware report expose only
-- building-level identifiers, so the unit link becomes optional. REST-sourced
-- leases are unaffected and still carry a unit.
ALTER TABLE "propertyware_leases"
  ALTER COLUMN "unitId" DROP NOT NULL,
  ALTER COLUMN "externalUnitId" DROP NOT NULL;

-- Which Propertyware surface a lease came from. Existing rows predate the
-- report fallback and are therefore REST-sourced.
ALTER TABLE "propertyware_leases"
  ADD COLUMN IF NOT EXISTS "sourceFeed" TEXT NOT NULL DEFAULT 'rest';

-- Report-derived leases are looked up by building; REST leases keep using the
-- unit index above.
CREATE INDEX IF NOT EXISTS "propertyware_leases_org_building_active_idx"
  ON "propertyware_leases" ("organizationId", "buildingId", "isActive");
