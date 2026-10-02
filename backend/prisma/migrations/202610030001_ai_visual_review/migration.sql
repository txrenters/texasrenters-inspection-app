-- The AI checks each finding against the recording it came from (the office,
-- 2026-10-03): whether the frames show it, which frame shows it best, and, on a
-- move-out, whether a move-in photograph already shows the same thing. It also
-- reports what the frames show that nobody mentioned.
--
-- Suggested frames live in their own table until a person accepts one, which
-- files it as a photograph under the finding. Nothing here reaches a report on
-- its own, and the AI decides nothing.
--
-- Additive only, and off by default (`visualReviewEnabled`): every existing
-- finding is a NARRATION finding with no visual check, which is what it was.

-- CreateEnum
CREATE TYPE "FindingSource" AS ENUM ('NARRATION', 'AI_VISION');
CREATE TYPE "VisualCheckStatus" AS ENUM ('VISIBLE', 'NOT_VISIBLE', 'UNCLEAR');
CREATE TYPE "BaselineVisualStatus" AS ENUM ('PRESENT_AT_MOVE_IN', 'NOT_AT_MOVE_IN', 'CANT_TELL');
CREATE TYPE "FrameSuggestionStatus" AS ENUM ('SUGGESTED', 'ACCEPTED', 'DISMISSED');

-- AlterTable
ALTER TABLE "OrganizationAiSettings" ADD COLUMN "visualReviewEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "InspectionFinding"
  ADD COLUMN "source" "FindingSource" NOT NULL DEFAULT 'NARRATION',
  ADD COLUMN "visualStatus" "VisualCheckStatus",
  ADD COLUMN "visualObservation" TEXT,
  ADD COLUMN "visualCheckedAt" TIMESTAMP(3),
  ADD COLUMN "baselineVisualStatus" "BaselineVisualStatus",
  ADD COLUMN "baselineVisualNote" TEXT,
  ADD COLUMN "baselinePhotoIds" UUID[] DEFAULT ARRAY[]::UUID[];

-- CreateTable
CREATE TABLE "FindingFrameSuggestion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "findingId" UUID NOT NULL,
    "inspectionMediaId" UUID NOT NULL,
    "atMs" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "boxX" DOUBLE PRECISION,
    "boxY" DOUBLE PRECISION,
    "boxWidth" DOUBLE PRECISION,
    "boxHeight" DOUBLE PRECISION,
    "observation" TEXT,
    "status" "FrameSuggestionStatus" NOT NULL DEFAULT 'SUGGESTED',
    "photoId" UUID,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FindingFrameSuggestion_pkey" PRIMARY KEY ("id"),
    -- A moment in a recording, and a box inside the frame.
    CONSTRAINT "FindingFrameSuggestion_atMs_check" CHECK ("atMs" >= 0),
    CONSTRAINT "FindingFrameSuggestion_box_check" CHECK (
      ("boxX" IS NULL AND "boxY" IS NULL AND "boxWidth" IS NULL AND "boxHeight" IS NULL)
      OR (
        "boxX" BETWEEN 0 AND 1 AND "boxY" BETWEEN 0 AND 1
        AND "boxWidth" > 0 AND "boxHeight" > 0
        AND "boxX" + "boxWidth" <= 1.0001 AND "boxY" + "boxHeight" <= 1.0001
      )
    )
    -- No check that an ACCEPTED row has a photograph: the photograph can be
    -- deleted afterwards (a report import clears them), and ON DELETE SET NULL
    -- would then trip it and refuse the delete.
);

-- CreateIndex
CREATE UNIQUE INDEX "FindingFrameSuggestion_photoId_key" ON "FindingFrameSuggestion"("photoId");
CREATE UNIQUE INDEX "FindingFrameSuggestion_findingId_inspectionMediaId_atMs_key" ON "FindingFrameSuggestion"("findingId", "inspectionMediaId", "atMs");
CREATE INDEX "FindingFrameSuggestion_inspectionId_idx" ON "FindingFrameSuggestion"("inspectionId");
CREATE INDEX "FindingFrameSuggestion_inspectionMediaId_status_idx" ON "FindingFrameSuggestion"("inspectionMediaId", "status");
CREATE INDEX "FindingFrameSuggestion_organizationId_idx" ON "FindingFrameSuggestion"("organizationId");

-- AddForeignKey
ALTER TABLE "FindingFrameSuggestion" ADD CONSTRAINT "FindingFrameSuggestion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FindingFrameSuggestion" ADD CONSTRAINT "FindingFrameSuggestion_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FindingFrameSuggestion" ADD CONSTRAINT "FindingFrameSuggestion_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "InspectionFinding"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FindingFrameSuggestion" ADD CONSTRAINT "FindingFrameSuggestion_inspectionMediaId_fkey" FOREIGN KEY ("inspectionMediaId") REFERENCES "InspectionMedia"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FindingFrameSuggestion" ADD CONSTRAINT "FindingFrameSuggestion_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "InspectionPhoto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant isolation.
--
-- It carries `organizationId` directly, so it is a "direct" table in the terms
-- `generate-rls-policies.mjs` uses. Written here rather than left to that
-- script's next run because a missing policy is invisible: the table simply
-- stays readable by everyone, and nothing fails to tell you.
ALTER TABLE "FindingFrameSuggestion" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "FindingFrameSuggestion"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
