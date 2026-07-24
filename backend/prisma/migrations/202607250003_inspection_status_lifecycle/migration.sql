-- Inspection status lifecycle: technician submission (≠ completion), human-only
-- finalization, and TBD / follow-up workflow (spec §11).

-- New status values. Placed to match the declared enum order; ADD VALUE is
-- append-only otherwise. The ALTER TABLE below does not use these new values,
-- so adding them in the same script is safe.
ALTER TYPE "InspectionStatus" ADD VALUE IF NOT EXISTS 'TECHNICIAN_SUBMITTED' AFTER 'IN_PROGRESS';
ALTER TYPE "InspectionStatus" ADD VALUE IF NOT EXISTS 'UNDER_REVIEW' AFTER 'REVIEW_REQUIRED';
ALTER TYPE "InspectionStatus" ADD VALUE IF NOT EXISTS 'TBD' AFTER 'UNDER_REVIEW';
ALTER TYPE "InspectionStatus" ADD VALUE IF NOT EXISTS 'FOLLOW_UP_REQUIRED' AFTER 'TBD';

ALTER TABLE "Inspection"
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "finalizedAt" TIMESTAMP(3),
  ADD COLUMN "finalizedById" UUID,
  ADD COLUMN "completionBlockedReason" TEXT,
  ADD COLUMN "tbdReason" TEXT,
  ADD COLUMN "followUpRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "followUpDueAt" TIMESTAMP(3),
  ADD COLUMN "followUpTasks" TEXT,
  ADD COLUMN "parentInspectionId" UUID,
  ADD COLUMN "inspectionRound" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Inspection"
  ADD CONSTRAINT "Inspection_finalizedById_fkey"
  FOREIGN KEY ("finalizedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Inspection"
  ADD CONSTRAINT "Inspection_parentInspectionId_fkey"
  FOREIGN KEY ("parentInspectionId") REFERENCES "Inspection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Inspection_parentInspectionId_idx" ON "Inspection"("parentInspectionId");
