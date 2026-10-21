-- A visit somebody has to book again, and how the office answered (2026-10-21).
--
-- A technician's "book it again" was a flag in the services report and a line
-- in the Jobber note: nothing listed them, nothing said whether one had been
-- booked, and a rebooking made in Jobber had no link back to the visit that
-- asked for it. Each one is now a row the console's queue answers -- moved,
-- booked again or dismissed -- and each answer reaches Jobber.
--
-- Additive: a new table, two new outbound kinds and a nullable column. The
-- previous image never reads any of them.

-- CreateEnum
CREATE TYPE "RescheduleRequestKind" AS ENUM ('BEFORE_VISIT', 'NO_ACCESS', 'SERVICES_NOT_DONE');
CREATE TYPE "RescheduleRequestStatus" AS ENUM ('OPEN', 'SENDING', 'DONE', 'DISMISSED');
CREATE TYPE "RescheduleRequestOutcome" AS ENUM ('MOVED', 'REBOOKED');

-- AlterEnum
ALTER TYPE "JobberOutboundKind" ADD VALUE IF NOT EXISTS 'RESCHEDULE_REQUESTED_NOTE';
ALTER TYPE "JobberOutboundKind" ADD VALUE IF NOT EXISTS 'RESCHEDULE_DISMISSED_NOTE';

-- CreateTable
CREATE TABLE "RescheduleRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "kind" "RescheduleRequestKind" NOT NULL,
    "status" "RescheduleRequestStatus" NOT NULL DEFAULT 'OPEN',
    "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT NOT NULL,
    "preferredOn" DATE,
    "requestedById" UUID,
    "clientRequestId" TEXT,
    "outcome" "RescheduleRequestOutcome",
    "resolvedInJobber" BOOLEAN NOT NULL DEFAULT false,
    "rebookInspectionId" UUID,
    "dismissReason" TEXT,
    "jobberError" TEXT,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RescheduleRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RescheduleRequest_organizationId_clientRequestId_key" ON "RescheduleRequest"("organizationId", "clientRequestId");
CREATE INDEX "RescheduleRequest_organizationId_status_createdAt_idx" ON "RescheduleRequest"("organizationId", "status", "createdAt");
CREATE INDEX "RescheduleRequest_inspectionId_idx" ON "RescheduleRequest"("inspectionId");
CREATE INDEX "RescheduleRequest_rebookInspectionId_idx" ON "RescheduleRequest"("rebookInspectionId");

-- At most one open request per visit: the newest account of a visit replaces
-- the one before it rather than queueing a second. Partial, so the visit's
-- answered requests stay as its history. Prisma cannot express this; the
-- schema's comment on the model points here.
CREATE UNIQUE INDEX "RescheduleRequest_one_open_per_inspection" ON "RescheduleRequest"("inspectionId") WHERE "status" IN ('OPEN', 'SENDING');

-- A rebooking is another visit, never the same one.
ALTER TABLE "RescheduleRequest" ADD CONSTRAINT "RescheduleRequest_rebook_is_another_visit" CHECK ("rebookInspectionId" IS NULL OR "rebookInspectionId" <> "inspectionId");

ALTER TABLE "RescheduleRequest" ADD CONSTRAINT "RescheduleRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RescheduleRequest" ADD CONSTRAINT "RescheduleRequest_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RescheduleRequest" ADD CONSTRAINT "RescheduleRequest_rebookInspectionId_fkey" FOREIGN KEY ("rebookInspectionId") REFERENCES "Inspection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RescheduleRequest" ADD CONSTRAINT "RescheduleRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RescheduleRequest" ADD CONSTRAINT "RescheduleRequest_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "JobberOutboundTask" ADD COLUMN "rescheduleRequestId" UUID;

CREATE UNIQUE INDEX "JobberOutboundTask_organizationId_rescheduleRequestId_kind_key" ON "JobberOutboundTask"("organizationId", "rescheduleRequestId", "kind");

ALTER TABLE "JobberOutboundTask" ADD CONSTRAINT "JobberOutboundTask_rescheduleRequestId_fkey" FOREIGN KEY ("rescheduleRequestId") REFERENCES "RescheduleRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation: a "direct" table, as `generate-rls-policies.mjs` puts it.
-- Written here because a missing policy is invisible -- the table simply stays
-- readable by every organization.
ALTER TABLE "RescheduleRequest" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "RescheduleRequest"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
