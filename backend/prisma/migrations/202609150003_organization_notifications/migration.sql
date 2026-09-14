-- What the office was told, kept so every console account sees the same list.
--
-- Notifications were broadcast to the consoles connected at that moment and
-- remembered only in each browser: two accounts saw different bells, and a
-- console that was closed never heard an inspection was submitted.
CREATE TABLE "OrganizationNotification" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "inspectionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationNotification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrganizationNotification_organizationId_createdAt_idx"
  ON "OrganizationNotification"("organizationId", "createdAt" DESC);

ALTER TABLE "OrganizationNotification"
  ADD CONSTRAINT "OrganizationNotification_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, as on every other table here. A missing policy is
-- invisible: nothing errors, the rows are simply readable by the wrong
-- organization.
ALTER TABLE "OrganizationNotification" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "OrganizationNotification"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
