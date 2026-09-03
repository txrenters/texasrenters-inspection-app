-- Reading a report outlives the request that asked for it, so the work needs a
-- row of its own to report progress into and to be found again from.
CREATE TABLE "InspectionImportJob" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "buildingId" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "ExtractionJobStatus" NOT NULL DEFAULT 'PENDING',
    "method" TEXT NOT NULL DEFAULT 'DETERMINISTIC',
    "provider" TEXT,
    "modelId" TEXT,
    "output" JSONB,
    "errorCode" TEXT,
    "inspectionId" UUID,
    "committedAt" TIMESTAMP(3),
    "startedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InspectionImportJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InspectionImportJob_organizationId_status_idx"
    ON "InspectionImportJob"("organizationId", "status");

-- The duplicate-import check reads by fingerprint within an organization.
CREATE INDEX "InspectionImportJob_organizationId_fingerprint_idx"
    ON "InspectionImportJob"("organizationId", "fingerprint");

ALTER TABLE "InspectionImportJob"
    ADD CONSTRAINT "InspectionImportJob_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
