-- Photo evidence with capture types (area overview / finding detail / supporting).
CREATE TYPE "PhotoCaptureType" AS ENUM ('AREA_OVERVIEW', 'FINDING_DETAIL', 'SUPPORTING_EVIDENCE');
CREATE TYPE "PhotoStorageStatus" AS ENUM ('PENDING', 'UPLOADED', 'FAILED');

CREATE TABLE "InspectionPhoto" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "inspectionId" UUID NOT NULL,
  "inspectionAreaId" UUID NOT NULL,
  "findingId" UUID,
  "capturedById" UUID NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'local',
  "storageKey" TEXT NOT NULL,
  "thumbnailKey" TEXT,
  "captureType" "PhotoCaptureType" NOT NULL DEFAULT 'AREA_OVERVIEW',
  "sequenceNumber" INTEGER NOT NULL DEFAULT 0,
  "label" TEXT,
  "notes" TEXT,
  "mimeType" TEXT NOT NULL,
  "storageStatus" "PhotoStorageStatus" NOT NULL DEFAULT 'UPLOADED',
  "width" INTEGER,
  "height" INTEGER,
  "sizeBytes" INTEGER,
  "idempotencyKey" TEXT,
  "localFileId" TEXT,
  "metadata" JSONB,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InspectionPhoto_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InspectionPhoto_storageKey_key" ON "InspectionPhoto"("storageKey");
CREATE UNIQUE INDEX "InspectionPhoto_idempotencyKey_key" ON "InspectionPhoto"("idempotencyKey");
CREATE INDEX "InspectionPhoto_inspectionAreaId_captureType_sequenceNumber_idx" ON "InspectionPhoto"("inspectionAreaId", "captureType", "sequenceNumber");
CREATE INDEX "InspectionPhoto_inspectionId_idx" ON "InspectionPhoto"("inspectionId");
CREATE INDEX "InspectionPhoto_findingId_idx" ON "InspectionPhoto"("findingId");
ALTER TABLE "InspectionPhoto" ADD CONSTRAINT "InspectionPhoto_inspectionAreaId_fkey" FOREIGN KEY ("inspectionAreaId") REFERENCES "InspectionArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InspectionPhoto" ADD CONSTRAINT "InspectionPhoto_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "InspectionFinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InspectionPhoto" ADD CONSTRAINT "InspectionPhoto_capturedById_fkey" FOREIGN KEY ("capturedById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
