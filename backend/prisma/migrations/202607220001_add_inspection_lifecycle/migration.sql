CREATE TYPE "InspectionType" AS ENUM ('MOVE_IN', 'OCCUPIED', 'BACK_TO_MARKET', 'MOVE_OUT');

ALTER TABLE "Inspection"
  ADD COLUMN "baselineInspectionId" UUID;

ALTER TABLE "Inspection"
  ALTER COLUMN "inspectionType" DROP DEFAULT,
  ALTER COLUMN "inspectionType" TYPE "InspectionType"
    USING "inspectionType"::"InspectionType",
  ALTER COLUMN "inspectionType" SET DEFAULT 'MOVE_OUT';

ALTER TABLE "Inspection"
  ADD CONSTRAINT "Inspection_baselineInspectionId_fkey"
  FOREIGN KEY ("baselineInspectionId") REFERENCES "Inspection"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Inspection_baselineInspectionId_idx"
  ON "Inspection"("baselineInspectionId");

CREATE INDEX "Inspection_lifecycle_lookup_idx"
  ON "Inspection"(
    "organizationId",
    "propertywareBuildingId",
    "propertywareUnitId",
    "propertywareLeaseId",
    "inspectionType",
    "scheduledAt"
  );
