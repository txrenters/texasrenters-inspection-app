-- The office teaches the AI (2026-10-03): house rules for what counts as
-- damage, wear and cleaning, kept in versions; a reason for every rejection,
-- from a fixed list the AI is shown as lessons; and, on each analysis, the
-- rules version it ran under, so a scorecard can compare versions.
--
-- Additive only. No organization has rules until it writes some, every
-- existing review keeps a free-text reason and no code, and every existing
-- analysis ran under no rules, which is what happened.

-- CreateEnum
CREATE TYPE "FindingRejectReason" AS ENUM ('NOT_IN_VIDEO', 'ALREADY_AT_MOVE_IN', 'NORMAL_WEAR', 'DUPLICATE', 'WRONG_ROOM', 'NOT_A_PROBLEM', 'OTHER');

-- AlterTable
ALTER TABLE "FindingReview" ADD COLUMN "reasonCode" "FindingRejectReason";

-- AlterTable
ALTER TABLE "AiAnalysisJob" ADD COLUMN "guidanceVersion" INTEGER;

-- CreateTable
CREATE TABLE "AiGuidanceVersion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiGuidanceVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiGuidanceVersion_version_check" CHECK ("version" > 0),
    -- Read into every analysis prompt: bounded, so it cannot crowd out the
    -- transcript it is meant to inform.
    CONSTRAINT "AiGuidanceVersion_text_check" CHECK (char_length("text") <= 8000)
);

-- CreateIndex
CREATE UNIQUE INDEX "AiGuidanceVersion_organizationId_version_key" ON "AiGuidanceVersion"("organizationId", "version");

-- AddForeignKey
ALTER TABLE "AiGuidanceVersion" ADD CONSTRAINT "AiGuidanceVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, as for every table carrying `organizationId` directly.
ALTER TABLE "AiGuidanceVersion" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "AiGuidanceVersion"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
