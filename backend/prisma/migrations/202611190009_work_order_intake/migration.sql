-- Work orders handed over by the maintenance app (2026-11-12). The in-house
-- crews' repair work orders arrive through the third-party gateway and become
-- visits here, so the crews' days are planned in one place. Two new visit
-- types that walk no rooms, a source that says who owns the record, the work
-- order's key on the visit so a repeated hand-off updates rather than
-- duplicates, and a staging table that keeps every hand-off whole.

-- Additive: existing rows keep every value they had. ADD VALUE is not
-- transactional on older Postgres and the new values are not used below, so
-- this runs cleanly on Supabase's Postgres whichever way the file is applied.
ALTER TYPE "InspectionType" ADD VALUE IF NOT EXISTS 'MAINTENANCE';
ALTER TYPE "InspectionType" ADD VALUE IF NOT EXISTS 'PEST_CONTROL';
ALTER TYPE "InspectionSource" ADD VALUE IF NOT EXISTS 'WORK_ORDER';

CREATE TYPE "WorkOrderImportStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

ALTER TABLE "Inspection"
    ADD COLUMN "workOrderKey" TEXT,
    ADD COLUMN "workOrderNumber" INTEGER;

-- One visit per work order. Postgres allows many NULLs in a unique index, so
-- every other inspection is unaffected.
CREATE UNIQUE INDEX "Inspection_organizationId_workOrderKey_key"
    ON "Inspection"("organizationId", "workOrderKey");

CREATE TABLE "WorkOrderImport" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "externalKey" TEXT NOT NULL,
    "workOrderNumber" INTEGER,
    "status" "WorkOrderImportStatus" NOT NULL DEFAULT 'RECEIVED',
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "payload" JSONB NOT NULL,
    "inspectionId" UUID,
    "receivedCount" INTEGER NOT NULL DEFAULT 1,
    "lastReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkOrderImport_pkey" PRIMARY KEY ("id")
);

-- One staging row per work order: a repeated hand-off lands on the same row.
CREATE UNIQUE INDEX "WorkOrderImport_organizationId_sourceSystem_externalKey_key"
    ON "WorkOrderImport"("organizationId", "sourceSystem", "externalKey");
CREATE INDEX "WorkOrderImport_organizationId_status_lastReceivedAt_idx"
    ON "WorkOrderImport"("organizationId", "status", "lastReceivedAt");
CREATE INDEX "WorkOrderImport_inspectionId_idx" ON "WorkOrderImport"("inspectionId");

ALTER TABLE "WorkOrderImport"
    ADD CONSTRAINT "WorkOrderImport_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkOrderImport"
    ADD CONSTRAINT "WorkOrderImport_inspectionId_fkey"
    FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
