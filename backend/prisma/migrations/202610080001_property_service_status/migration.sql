-- The office's own switches on a property, for what Propertyware is late to say
-- (the office, 2026-10-08): the owner ended Texas Renters' management, so
-- nothing more is booked there; or the property left the tenant benefit
-- package, so its quarterly occupied and HVAC visits stop. The lease schedule
-- had been booking move-outs and move-ins at properties no longer managed.
--
-- A table of its own, keyed by property, so the Propertyware sync never writes
-- over it. Additive: a property with no row has neither switch on, which is
-- every property today.
CREATE TABLE "PropertyServiceStatus" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "buildingId" UUID NOT NULL,
    "managementEndedAt" TIMESTAMP(3),
    "managementEndedById" UUID,
    "tbpOptedOutAt" TIMESTAMP(3),
    "tbpOptedOutById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyServiceStatus_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PropertyServiceStatus_buildingId_key" ON "PropertyServiceStatus"("buildingId");
CREATE INDEX "PropertyServiceStatus_organizationId_idx" ON "PropertyServiceStatus"("organizationId");

ALTER TABLE "PropertyServiceStatus" ADD CONSTRAINT "PropertyServiceStatus_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PropertyServiceStatus" ADD CONSTRAINT "PropertyServiceStatus_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "propertyware_buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PropertyServiceStatus" ADD CONSTRAINT "PropertyServiceStatus_managementEndedById_fkey" FOREIGN KEY ("managementEndedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PropertyServiceStatus" ADD CONSTRAINT "PropertyServiceStatus_tbpOptedOutById_fkey" FOREIGN KEY ("tbpOptedOutById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant isolation: a "direct" table, as `generate-rls-policies.mjs` puts it.
-- Written here because a missing policy is invisible -- the table simply stays
-- readable by every organization.
ALTER TABLE "PropertyServiceStatus" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "PropertyServiceStatus"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
