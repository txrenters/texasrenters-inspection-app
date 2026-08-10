-- A reviewer asking the technician for more evidence in one specific area.
--
-- The office could already send an inspection back, but only as a whole: the
-- technician saw a job reappear in their queue with no statement of what was
-- missing. This names the area, optionally the exact checklist items, and what
-- is needed.
--
-- checklistItemIds empty means "the whole area". Stored as a uuid array rather
-- than a join table because the list is small, always read with its parent and
-- never queried from the other side; the ids are validated against the area's
-- own checklist at creation.

-- CreateEnum
CREATE TYPE "EvidenceRequestStatus" AS ENUM ('OPEN', 'RESOLVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "AreaEvidenceRequest" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "inspectionAreaId" UUID NOT NULL,
    "checklistItemIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "note" TEXT NOT NULL,
    "status" "EvidenceRequestStatus" NOT NULL DEFAULT 'OPEN',
    "requestedById" UUID NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AreaEvidenceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AreaEvidenceRequest_inspectionId_status_idx" ON "AreaEvidenceRequest"("inspectionId", "status");

-- CreateIndex
CREATE INDEX "AreaEvidenceRequest_inspectionAreaId_idx" ON "AreaEvidenceRequest"("inspectionAreaId");

-- CreateIndex
CREATE INDEX "AreaEvidenceRequest_organizationId_idx" ON "AreaEvidenceRequest"("organizationId");

-- AddForeignKey
ALTER TABLE "AreaEvidenceRequest" ADD CONSTRAINT "AreaEvidenceRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaEvidenceRequest" ADD CONSTRAINT "AreaEvidenceRequest_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaEvidenceRequest" ADD CONSTRAINT "AreaEvidenceRequest_inspectionAreaId_fkey" FOREIGN KEY ("inspectionAreaId") REFERENCES "InspectionArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant isolation, matching what scripts/generate-rls-policies.mjs emits for a
-- table carrying its own organizationId. Included here rather than in a
-- follow-up migration because the generator reads the live foreign-key graph
-- and can only see this table once the CREATE has run; regenerating afterwards
-- reproduces exactly this policy.
--
-- FAILS CLOSED: an unset app.organization_id matches nothing, so a missed
-- application-level filter returns no rows instead of another tenant's
-- requests. '*' stays the explicit system escape hatch.
alter table "AreaEvidenceRequest" enable row level security;
drop policy if exists tenant_isolation on "AreaEvidenceRequest";
create policy tenant_isolation on "AreaEvidenceRequest"
  using (
        current_setting('app.organization_id', true) = '*'
        or "organizationId"::text = current_setting('app.organization_id', true)
  )
  with check (
        current_setting('app.organization_id', true) = '*'
        or "organizationId"::text = current_setting('app.organization_id', true)
  );
