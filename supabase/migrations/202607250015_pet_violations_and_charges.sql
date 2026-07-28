-- Supabase mirror of Prisma migration 202607250005_pet_violations_and_charges.
-- Pet violation rule + configurable charges (spec §13/§14).

DO $$ BEGIN CREATE TYPE "PetReviewStatus" AS ENUM ('PENDING_REVIEW', 'UNIQUE_PET', 'DUPLICATE', 'INSUFFICIENT_EVIDENCE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PetAuthorizationStatus" AS ENUM ('UNKNOWN', 'AUTHORIZED', 'UNAUTHORIZED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ChargeStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ADJUSTED', 'WAIVED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ChargeCalculationType" AS ENUM ('PER_UNIQUE_ENTITY', 'FLAT', 'PER_UNIT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ChargeSource" AS ENUM ('AI_SUGGESTED', 'TECHNICIAN', 'SYSTEM', 'ADMINISTRATOR'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ChargeRule" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "ChargeRule_organizationId_code_key" ON "ChargeRule"("organizationId", "code");
CREATE INDEX IF NOT EXISTS "ChargeRule_organizationId_isActive_idx" ON "ChargeRule"("organizationId", "isActive");

CREATE TABLE IF NOT EXISTS "PetCandidate" (
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
CREATE INDEX IF NOT EXISTS "PetCandidate_inspectionId_idx" ON "PetCandidate"("inspectionId");

CREATE TABLE IF NOT EXISTS "PetObservation" (
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
CREATE INDEX IF NOT EXISTS "PetObservation_inspectionId_idx" ON "PetObservation"("inspectionId");
CREATE INDEX IF NOT EXISTS "PetObservation_petCandidateId_idx" ON "PetObservation"("petCandidateId");

CREATE TABLE IF NOT EXISTS "Charge" (
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
CREATE INDEX IF NOT EXISTS "Charge_inspectionId_status_idx" ON "Charge"("inspectionId", "status");
CREATE INDEX IF NOT EXISTS "Charge_petCandidateId_idx" ON "Charge"("petCandidateId");

DO $$ BEGIN ALTER TABLE "ChargeRule" ADD CONSTRAINT "ChargeRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "PetCandidate" ADD CONSTRAINT "PetCandidate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "PetCandidate" ADD CONSTRAINT "PetCandidate_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "PetObservation" ADD CONSTRAINT "PetObservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "PetObservation" ADD CONSTRAINT "PetObservation_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "PetObservation" ADD CONSTRAINT "PetObservation_petCandidateId_fkey" FOREIGN KEY ("petCandidateId") REFERENCES "PetCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Charge" ADD CONSTRAINT "Charge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Charge" ADD CONSTRAINT "Charge_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Charge" ADD CONSTRAINT "Charge_petCandidateId_fkey" FOREIGN KEY ("petCandidateId") REFERENCES "PetCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
