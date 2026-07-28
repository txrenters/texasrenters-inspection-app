-- Move-in vs move-out comparison (spec §12): one comparison per move-out
-- inspection, plus per-area results. Draft until a human approves it.

CREATE TYPE "ComparisonStatus" AS ENUM ('DRAFT', 'UNDER_REVIEW', 'APPROVED', 'REJECTED');
CREATE TYPE "ComparisonClassification" AS ENUM (
  'UNCHANGED', 'IMPROVED', 'NEW_DAMAGE', 'WORSENED', 'RESOLVED',
  'MISSING_BASELINE', 'MISSING_MOVE_OUT_EVIDENCE', 'NOT_COMPARABLE', 'REQUIRES_REVIEW'
);
CREATE TYPE "ComparisonMatchMethod" AS ENUM (
  'LOCAL_AREA_ID', 'APPROVED_ALIAS', 'NORMALIZED_NAME', 'AREA_CATEGORY',
  'CONFIGURED_MAPPING', 'AI_SUGGESTED', 'MANUAL', 'UNMATCHED'
);

CREATE TABLE "InspectionComparison" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "moveOutInspectionId" UUID NOT NULL,
  "moveInInspectionId" UUID NOT NULL,
  "status" "ComparisonStatus" NOT NULL DEFAULT 'DRAFT',
  "overallCondition" "ComparisonClassification" NOT NULL DEFAULT 'REQUIRES_REVIEW',
  "version" INTEGER NOT NULL DEFAULT 1,
  "generator" TEXT NOT NULL DEFAULT 'DETERMINISTIC',
  "requiresReviewCount" INTEGER NOT NULL DEFAULT 0,
  "summary" TEXT,
  "reviewedById" UUID,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "metadata" JSONB,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InspectionComparison_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InspectionComparison_moveOutInspectionId_key"
  ON "InspectionComparison"("moveOutInspectionId");
CREATE INDEX "InspectionComparison_organizationId_idx"
  ON "InspectionComparison"("organizationId");
CREATE INDEX "InspectionComparison_moveInInspectionId_idx"
  ON "InspectionComparison"("moveInInspectionId");

CREATE TABLE "InspectionAreaComparison" (
  "id" UUID NOT NULL,
  "comparisonId" UUID NOT NULL,
  "moveInPropertyAreaId" UUID,
  "moveOutPropertyAreaId" UUID,
  "areaName" TEXT NOT NULL,
  "floorName" TEXT,
  "classification" "ComparisonClassification" NOT NULL,
  "matchMethod" "ComparisonMatchMethod" NOT NULL DEFAULT 'UNMATCHED',
  "matchConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "requiresReview" BOOLEAN NOT NULL DEFAULT false,
  "summary" TEXT,
  "originalClassification" "ComparisonClassification",
  "overriddenById" UUID,
  "overriddenAt" TIMESTAMP(3),
  "overrideReason" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InspectionAreaComparison_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InspectionAreaComparison_comparisonId_idx"
  ON "InspectionAreaComparison"("comparisonId");

ALTER TABLE "InspectionComparison"
  ADD CONSTRAINT "InspectionComparison_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InspectionComparison"
  ADD CONSTRAINT "InspectionComparison_moveOutInspectionId_fkey"
  FOREIGN KEY ("moveOutInspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InspectionComparison"
  ADD CONSTRAINT "InspectionComparison_moveInInspectionId_fkey"
  FOREIGN KEY ("moveInInspectionId") REFERENCES "Inspection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InspectionComparison"
  ADD CONSTRAINT "InspectionComparison_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InspectionAreaComparison"
  ADD CONSTRAINT "InspectionAreaComparison_comparisonId_fkey"
  FOREIGN KEY ("comparisonId") REFERENCES "InspectionComparison"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InspectionAreaComparison"
  ADD CONSTRAINT "InspectionAreaComparison_overriddenById_fkey"
  FOREIGN KEY ("overriddenById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
