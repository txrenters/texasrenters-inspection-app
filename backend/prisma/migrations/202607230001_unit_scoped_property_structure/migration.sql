-- Multi-unit support: floor plans, floors, and areas gain an optional unit
-- dimension. unitId NULL keeps today's semantics (structure belongs to the
-- whole building — correct for single-family homes and identical-layout
-- buildings); unitId set scopes the structure to one unit (A/B/C).
--
-- Unique indexes are created NULLS NOT DISTINCT (PostgreSQL 15+) so that
-- building-level rows (unitId NULL) remain unique among themselves instead of
-- Postgres treating every NULL as distinct.

ALTER TABLE "PropertyFloorPlan" ADD COLUMN "unitId" UUID;
ALTER TABLE "PropertyFloor" ADD COLUMN "unitId" UUID;
ALTER TABLE "PropertyArea" ADD COLUMN "unitId" UUID;

ALTER TABLE "PropertyFloorPlan"
  ADD CONSTRAINT "PropertyFloorPlan_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "propertyware_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertyFloor"
  ADD CONSTRAINT "PropertyFloor_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "propertyware_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertyArea"
  ADD CONSTRAINT "PropertyArea_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "propertyware_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "PropertyFloorPlan_propertyId_unitId_idx" ON "PropertyFloorPlan"("propertyId", "unitId");

-- Floor names: unique per building+unit (NULL unit = building level).
DROP INDEX IF EXISTS "PropertyFloor_propertyId_name_key";
CREATE UNIQUE INDEX "PropertyFloor_propertyId_unitId_name_key"
  ON "PropertyFloor"("propertyId", "unitId", "name") NULLS NOT DISTINCT;

-- Area names: unique per building+unit+floor (NULL unit = building level).
DROP INDEX IF EXISTS "PropertyArea_propertyId_floorId_name_key";
CREATE UNIQUE INDEX "PropertyArea_propertyId_unitId_floorId_name_key"
  ON "PropertyArea"("propertyId", "unitId", "floorId", "name") NULLS NOT DISTINCT;

DROP INDEX IF EXISTS "PropertyArea_propertyId_floorId_inspectionOrder_idx";
CREATE INDEX "PropertyArea_propertyId_unitId_floorId_inspectionOrder_idx"
  ON "PropertyArea"("propertyId", "unitId", "floorId", "inspectionOrder");

-- Close the duplicate-inspection race: at most one non-cancelled inspection
-- per organization + building + unit + scheduled time. Partial indexes are not
-- expressible in the Prisma schema, so this exists only at the database level.
CREATE UNIQUE INDEX "Inspection_org_building_unit_schedule_key"
  ON "Inspection"("organizationId", "propertywareBuildingId", "propertywareUnitId", "scheduledAt")
  NULLS NOT DISTINCT
  WHERE "status" <> 'CANCELLED' AND "propertywareBuildingId" IS NOT NULL;
