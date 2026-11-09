-- Sending invoices to Xero (2026-11-10, phase 3 of the Xero plan).
--
-- The switch: nothing is sent until somebody who runs the integrations turns
-- it on, and only while everything phase 2 asks for is in place. A run claims
-- the office (`sendingClaimedUntil`) so two never send at once.
ALTER TABLE "XeroSettings"
  ADD COLUMN "sendingEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sendingChangedAt" TIMESTAMP(3),
  ADD COLUMN "sendingClaimedUntil" TIMESTAMP(3),
  ADD COLUMN "lastRunAt" TIMESTAMP(3),
  ADD COLUMN "lastRunProblem" TEXT;

-- Whether Xero's own invoice reminders are on, as last read. Null when Xero
-- did not say. On, Xero would email the office's clients beside the console.
ALTER TABLE "XeroConnection" ADD COLUMN "invoiceRemindersOn" BOOLEAN;

-- The Xero contact each client is sent under: the client is the property, as
-- in Jobber. Per Xero organisation, so connecting another one starts afresh.
CREATE TABLE "XeroContactLink" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "xeroTenantId" TEXT NOT NULL,
    -- "jobber:<client id>", or "name:<client name, lower-cased>" for a client Jobber did not name.
    "clientKey" TEXT NOT NULL,
    "xeroContactId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XeroContactLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "XeroContactLink_organizationId_xeroTenantId_clientKey_key" ON "XeroContactLink"("organizationId", "xeroTenantId", "clientKey");

ALTER TABLE "XeroContactLink" ADD CONSTRAINT "XeroContactLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "XeroContactLink" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "XeroContactLink"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

-- Each invoice's state in Xero: what was last sent (a fingerprint of the
-- invoice's own content), Xero's id for it, and -- when it was refused -- why,
-- how many tries, and when to try again. An invoice is looked at again only
-- when it changed since it was last seen, or its retry is due.
CREATE TABLE "XeroInvoiceSync" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "xeroTenantId" TEXT NOT NULL,
    "xeroInvoiceId" TEXT,
    "status" TEXT NOT NULL,
    "sentFingerprint" TEXT,
    "seenUpdatedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "problem" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroInvoiceSync_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "XeroInvoiceSync_invoiceId_key" ON "XeroInvoiceSync"("invoiceId");
CREATE INDEX "XeroInvoiceSync_organizationId_status_idx" ON "XeroInvoiceSync"("organizationId", "status");

ALTER TABLE "XeroInvoiceSync" ADD CONSTRAINT "XeroInvoiceSync_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "XeroInvoiceSync" ADD CONSTRAINT "XeroInvoiceSync_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "XeroInvoiceSync" ADD CONSTRAINT "XeroInvoiceSync_status_known" CHECK ("status" IN ('SENT', 'FAILED'));
ALTER TABLE "XeroInvoiceSync" ADD CONSTRAINT "XeroInvoiceSync_attempts_counted" CHECK ("attempts" >= 0);
-- A sent invoice has Xero's id for it.
ALTER TABLE "XeroInvoiceSync" ADD CONSTRAINT "XeroInvoiceSync_sent_has_id" CHECK ("status" <> 'SENT' OR "xeroInvoiceId" IS NOT NULL);

ALTER TABLE "XeroInvoiceSync" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "XeroInvoiceSync"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
