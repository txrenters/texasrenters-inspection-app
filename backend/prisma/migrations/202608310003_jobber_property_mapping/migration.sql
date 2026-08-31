-- The mapping layer between Jobber and Propertyware.
--
-- Jobber and Propertyware share no key, and an Inspection cannot be created
-- without a propertywareBuildingId. Every Jobber visit therefore passes through
-- a link a human can inspect and correct; unmatched links ARE the review queue.

CREATE TYPE "JobberLinkStatus" AS ENUM ('LINKED', 'UNMATCHED', 'AMBIGUOUS', 'IGNORED');
CREATE TYPE "JobberLinkMethod" AS ENUM ('ADDRESS_EXACT', 'MANUAL');
CREATE TYPE "JobberVisitImportStatus" AS ENUM ('PENDING', 'IMPORTED', 'UNMATCHED_PROPERTY', 'REJECTED', 'IGNORED');

CREATE TABLE "JobberPropertyLink" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "jobberPropertyId" TEXT NOT NULL,
    "jobberClientId" TEXT,
    "jobberClientName" TEXT,
    "jobberAddress" TEXT,
    "normalizedAddressKey" TEXT,
    "status" "JobberLinkStatus" NOT NULL DEFAULT 'UNMATCHED',
    "method" "JobberLinkMethod",
    "propertywareBuildingId" UUID,
    "propertywareUnitId" UUID,
    "propertywareLeaseId" UUID,
    "unresolvedReason" TEXT,
    "linkedByUserId" UUID,
    "linkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobberPropertyLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JobberVisitImport" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "jobberVisitId" TEXT NOT NULL,
    "jobberJobId" TEXT,
    "linkId" UUID,
    "status" "JobberVisitImportStatus" NOT NULL DEFAULT 'PENDING',
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "payload" JSONB,
    "inspectionId" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobberVisitImport_pkey" PRIMARY KEY ("id")
);

-- One link per Jobber property: two would mean two answers to "which building
-- is this", and the sync would take whichever it read first.
CREATE UNIQUE INDEX "JobberPropertyLink_organizationId_jobberPropertyId_key"
    ON "JobberPropertyLink"("organizationId", "jobberPropertyId");
CREATE INDEX "JobberPropertyLink_organizationId_status_idx"
    ON "JobberPropertyLink"("organizationId", "status");
-- Candidate lookup during matching is one indexed hit, not a scan of 570 rows.
CREATE INDEX "JobberPropertyLink_organizationId_normalizedAddressKey_idx"
    ON "JobberPropertyLink"("organizationId", "normalizedAddressKey");

-- One import record per visit: what makes a replayed webhook or an overlapping
-- sync window harmless.
CREATE UNIQUE INDEX "JobberVisitImport_organizationId_jobberVisitId_key"
    ON "JobberVisitImport"("organizationId", "jobberVisitId");
CREATE INDEX "JobberVisitImport_organizationId_status_idx"
    ON "JobberVisitImport"("organizationId", "status");
CREATE INDEX "JobberVisitImport_linkId_status_idx"
    ON "JobberVisitImport"("linkId", "status");

ALTER TABLE "JobberPropertyLink" ADD CONSTRAINT "JobberPropertyLink_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobberPropertyLink" ADD CONSTRAINT "JobberPropertyLink_propertywareBuildingId_fkey"
    FOREIGN KEY ("propertywareBuildingId") REFERENCES "propertyware_buildings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JobberPropertyLink" ADD CONSTRAINT "JobberPropertyLink_propertywareUnitId_fkey"
    FOREIGN KEY ("propertywareUnitId") REFERENCES "propertyware_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JobberPropertyLink" ADD CONSTRAINT "JobberPropertyLink_propertywareLeaseId_fkey"
    FOREIGN KEY ("propertywareLeaseId") REFERENCES "propertyware_leases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "JobberVisitImport" ADD CONSTRAINT "JobberVisitImport_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobberVisitImport" ADD CONSTRAINT "JobberVisitImport_linkId_fkey"
    FOREIGN KEY ("linkId") REFERENCES "JobberPropertyLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;
