-- Supabase mirror of Prisma migration 202607250003_inspection_status_lifecycle.
-- Inspection status lifecycle: technician submission (≠ completion), human-only
-- finalization, and TBD / follow-up workflow (spec §11).

ALTER TYPE "InspectionStatus" ADD VALUE IF NOT EXISTS 'TECHNICIAN_SUBMITTED' AFTER 'IN_PROGRESS';
ALTER TYPE "InspectionStatus" ADD VALUE IF NOT EXISTS 'UNDER_REVIEW' AFTER 'REVIEW_REQUIRED';
ALTER TYPE "InspectionStatus" ADD VALUE IF NOT EXISTS 'TBD' AFTER 'UNDER_REVIEW';
ALTER TYPE "InspectionStatus" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_REQUIRED' AFTER 'TBD';

ALTER TABLE "Inspection"
  ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "finalizedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "finalizedById" UUID,
  ADD COLUMN IF NOT EXISTS "completionBlockedReason" TEXT,
  ADD COLUMN IF NOT EXISTS "tbdReason" TEXT,
  ADD COLUMN IF NOT EXISTS "followUpRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "followUpDueAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "followUpTasks" TEXT,
  ADD COLUMN IF NOT EXISTS "parentInspectionId" UUID,
  ADD COLUMN IF NOT EXISTS "inspectionRound" INTEGER NOT NULL DEFAULT 1;

DO $$ BEGIN
  ALTER TABLE "Inspection"
    ADD CONSTRAINT "Inspection_finalizedById_fkey"
    FOREIGN KEY ("finalizedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Inspection"
    ADD CONSTRAINT "Inspection_parentInspectionId_fkey"
    FOREIGN KEY ("parentInspectionId") REFERENCES "Inspection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "Inspection_parentInspectionId_idx" ON "Inspection"("parentInspectionId");
