-- Mirror of backend/prisma/migrations/202607250008_lease_report_fallback.
-- Leases sourced from the published Propertyware report expose only
-- building-level identifiers, so the unit link becomes optional.
ALTER TABLE "propertyware_leases"
  ALTER COLUMN "unitId" DROP NOT NULL,
  ALTER COLUMN "externalUnitId" DROP NOT NULL;

ALTER TABLE "propertyware_leases"
  ADD COLUMN IF NOT EXISTS "sourceFeed" TEXT NOT NULL DEFAULT 'rest';

CREATE INDEX IF NOT EXISTS "propertyware_leases_org_building_active_idx"
  ON "propertyware_leases" ("organizationId", "buildingId", "isActive");
