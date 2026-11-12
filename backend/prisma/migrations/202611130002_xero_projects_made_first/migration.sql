-- A project made first (2026-11-13): the office makes a visit's project in the
-- console's New project dialog before its invoice, as it does in Xero, and
-- picks it on the invoice. The company's projects in progress are read from
-- Xero every six hours, so the form offers them with no call to Xero.

ALTER TABLE "XeroSettings" ADD COLUMN "projectsReadAt" TIMESTAMP(3);

CREATE TABLE "XeroProject" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "xeroTenantId" TEXT NOT NULL,
    "xeroProjectId" TEXT NOT NULL,
    "xeroContactId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INPROGRESS',
    "deadlineOn" DATE,
    "estimateCents" INTEGER,
    "madeHere" BOOLEAN NOT NULL DEFAULT false,
    "madeByUserId" UUID,
    "clientRequestId" TEXT,
    "seenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroProject_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "XeroProject_organizationId_xeroTenantId_xeroProjectId_key" ON "XeroProject"("organizationId", "xeroTenantId", "xeroProjectId");
CREATE UNIQUE INDEX "XeroProject_organizationId_clientRequestId_key" ON "XeroProject"("organizationId", "clientRequestId");
CREATE INDEX "XeroProject_organizationId_xeroTenantId_xeroContactId_status_idx" ON "XeroProject"("organizationId", "xeroTenantId", "xeroContactId", "status");

ALTER TABLE "XeroProject" ADD CONSTRAINT "XeroProject_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "XeroProject" ADD CONSTRAINT "XeroProject_organizationId_xeroTenantId_fkey" FOREIGN KEY ("organizationId", "xeroTenantId") REFERENCES "XeroOrganisation"("organizationId", "xeroTenantId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "XeroProject" ADD CONSTRAINT "XeroProject_status_known" CHECK ("status" IN ('INPROGRESS', 'CLOSED'));
ALTER TABLE "XeroProject" ADD CONSTRAINT "XeroProject_name_given" CHECK (length(btrim("name")) > 0);
ALTER TABLE "XeroProject" ADD CONSTRAINT "XeroProject_estimate_counted" CHECK ("estimateCents" IS NULL OR "estimateCents" >= 0);
-- Only one made here has a maker or a dialog's key.
ALTER TABLE "XeroProject" ADD CONSTRAINT "XeroProject_key_made_here" CHECK ("madeHere" OR ("clientRequestId" IS NULL AND "madeByUserId" IS NULL));

-- A visit's project made or chosen first is PENDING while the labour on one made here waits for its invoice to be in
-- Xero; the sending run then logs it.
ALTER TABLE "XeroProjectLink" DROP CONSTRAINT "XeroProjectLink_status_known";
ALTER TABLE "XeroProjectLink" ADD CONSTRAINT "XeroProjectLink_status_known" CHECK ("status" IN ('DONE', 'PENDING', 'FAILED'));
ALTER TABLE "XeroProjectLink" ADD CONSTRAINT "XeroProjectLink_pending_has_project" CHECK ("status" <> 'PENDING' OR "xeroProjectId" IS NOT NULL);

ALTER TABLE "XeroProject" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "XeroProject"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
