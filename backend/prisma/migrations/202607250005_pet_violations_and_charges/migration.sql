-- Pet violation rule + configurable charges (spec §13/§14). Technicians record
-- pet evidence; a human reviews uniqueness/authorization and finalizes charges.

CREATE TYPE "PetReviewStatus" AS ENUM ('PENDING_REVIEW', 'UNIQUE_PET', 'DUPLICATE', 'INSUFFICIENT_EVIDENCE');
CREATE TYPE "PetAuthorizationStatus" AS ENUM ('UNKNOWN', 'AUTHORIZED', 'UNAUTHORIZED');
CREATE TYPE "ChargeStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ADJUSTED', 'WAIVED');
CREATE TYPE "ChargeCalculationType" AS ENUM ('PER_UNIQUE_ENTITY', 'FLAT', 'PER_UNIT');
CREATE TYPE "ChargeSource" AS ENUM ('AI_SUGGESTED', 'TECHNICIAN', 'SYSTEM', 'ADMINISTRATOR');

CREATE TABLE "ChargeRule" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "description" TEXT,
  "amount" DECIMAL(10, 2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "calculationType" "ChargeCalculationType" NOT NULL DEFAULT 'PER_UNIQUE_ENTITY',
  "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "effectiveTo" TIMESTAMP(3),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChargeRule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ChargeRule_organizationId_code_key" ON "ChargeRule"("organizationId", "code");
CREATE INDEX "ChargeRule_organizationId_isActive_idx" ON "ChargeRule"("organizationId", "isActive");

CREATE TABLE "PetCandidate" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "inspectionId" UUID NOT NULL,
  "species" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT,
  "reviewStatus" "PetReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "authorizationStatus" "PetAuthorizationStatus" NOT NULL DEFAULT 'UNKNOWN',
  "observationCount" INTEGER NOT NULL DEFAULT 0,
  "reviewedById" UUID,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PetCandidate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PetCandidate_inspectionId_idx" ON "PetCandidate"("inspectionId");

CREATE TABLE "PetObservation" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "inspectionId" UUID NOT NULL,
  "propertyAreaId" UUID,
  "petCandidateId" UUID,
  "temporaryLabel" TEXT NOT NULL,
  "species" TEXT NOT NULL,
  "description" TEXT,
  "characteristics" TEXT,
  "notes" TEXT,
  "photoIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "mediaIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "possibleDuplicateOfId" UUID,
  "recordedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PetObservation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PetObservation_inspectionId_idx" ON "PetObservation"("inspectionId");
CREATE INDEX "PetObservation_petCandidateId_idx" ON "PetObservation"("petCandidateId");

CREATE TABLE "Charge" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "inspectionId" UUID NOT NULL,
  "chargeCode" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "propertyAreaId" UUID,
  "findingId" UUID,
  "petCandidateId" UUID,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "unitAmount" DECIMAL(10, 2) NOT NULL,
  "proposedAmount" DECIMAL(10, 2) NOT NULL,
  "approvedAmount" DECIMAL(10, 2),
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" "ChargeStatus" NOT NULL DEFAULT 'DRAFT',
  "source" "ChargeSource" NOT NULL DEFAULT 'SYSTEM',
  "reason" TEXT,
  "evidenceRefs" JSONB,
  "reviewedById" UUID,
  "reviewedAt" TIMESTAMP(3),
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Charge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Charge_inspectionId_status_idx" ON "Charge"("inspectionId", "status");
CREATE INDEX "Charge_petCandidateId_idx" ON "Charge"("petCandidateId");

ALTER TABLE "ChargeRule"
  ADD CONSTRAINT "ChargeRule_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PetCandidate"
  ADD CONSTRAINT "PetCandidate_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PetCandidate"
  ADD CONSTRAINT "PetCandidate_inspectionId_fkey"
  FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PetObservation"
  ADD CONSTRAINT "PetObservation_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PetObservation"
  ADD CONSTRAINT "PetObservation_inspectionId_fkey"
  FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PetObservation"
  ADD CONSTRAINT "PetObservation_petCandidateId_fkey"
  FOREIGN KEY ("petCandidateId") REFERENCES "PetCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Charge"
  ADD CONSTRAINT "Charge_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Charge"
  ADD CONSTRAINT "Charge_inspectionId_fkey"
  FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Charge"
  ADD CONSTRAINT "Charge_petCandidateId_fkey"
  FOREIGN KEY ("petCandidateId") REFERENCES "PetCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
