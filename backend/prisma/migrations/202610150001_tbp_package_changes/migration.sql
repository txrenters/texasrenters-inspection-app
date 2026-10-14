-- When a property joined or left the tenant benefit package, and why (the
-- office, 2026-10-15: "we should have a way to know if a property has opted out
-- or left the TBP"). The nightly tenant sync overwrites a tenancy's enrolment in
-- place, so a Yes that became a No left no trace. One row per change of a
-- building's membership, written by the sync and by the office's switches.
--
-- Additive: a new table, empty until the next change.
CREATE TYPE "TbpPackageChangeKind" AS ENUM ('JOINED', 'LEFT');

CREATE TYPE "TbpPackageChangeSource" AS ENUM ('TENANT_REPORT', 'OFFICE');

CREATE TABLE "TbpPackageChange" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "buildingId" UUID NOT NULL,
    "kind" "TbpPackageChangeKind" NOT NULL,
    "source" "TbpPackageChangeSource" NOT NULL,
    "reason" TEXT,
    "detail" TEXT,
    "actorUserId" UUID,
    "actorName" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TbpPackageChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TbpPackageChange_organizationId_occurredAt_idx" ON "TbpPackageChange"("organizationId", "occurredAt");

CREATE INDEX "TbpPackageChange_buildingId_occurredAt_idx" ON "TbpPackageChange"("buildingId", "occurredAt");

ALTER TABLE "TbpPackageChange" ADD CONSTRAINT "TbpPackageChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TbpPackageChange" ADD CONSTRAINT "TbpPackageChange_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "propertyware_buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation: a "direct" table, as `generate-rls-policies.mjs` puts it.
-- Written here because a missing policy is invisible -- the table simply stays
-- readable by every organization.
ALTER TABLE "TbpPackageChange" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "TbpPackageChange"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
