-- Work owed to Jobber, written in the same transaction as the thing that owes it.
--
-- An outbox rather than a call at finalization: signing off on evidence must not
-- fail because Jobber is unreachable, and must not be rolled back by a network
-- error after finalizedAt has frozen that evidence.

CREATE TYPE "JobberOutboundKind" AS ENUM ('VISIT_COMPLETED');
CREATE TYPE "JobberOutboundStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'ABANDONED');

CREATE TABLE "JobberOutboundTask" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "jobberVisitId" TEXT NOT NULL,
    "jobberJobId" TEXT,
    "kind" "JobberOutboundKind" NOT NULL,
    "status" "JobberOutboundStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobberOutboundTask_pkey" PRIMARY KEY ("id")
);

-- One completion push per inspection. A re-finalize must not tell Jobber twice,
-- and the enqueue relies on this constraint rather than on reading first.
CREATE UNIQUE INDEX "JobberOutboundTask_organizationId_inspectionId_kind_key"
    ON "JobberOutboundTask"("organizationId", "inspectionId", "kind");
CREATE INDEX "JobberOutboundTask_organizationId_status_nextAttemptAt_idx"
    ON "JobberOutboundTask"("organizationId", "status", "nextAttemptAt");

ALTER TABLE "JobberOutboundTask" ADD CONSTRAINT "JobberOutboundTask_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobberOutboundTask" ADD CONSTRAINT "JobberOutboundTask_inspectionId_fkey"
    FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
