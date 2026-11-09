-- The office's choices for sending to Xero (2026-11-10, phase 2 of the Xero
-- plan): from which day invoices go, the account each product or service's
-- sales are posted to (by its name, as lines are priced), the account each
-- payment method lands in, and the tax type on a line. One row per office.
-- Account ids are Xero's; the console checks them against its last read of the
-- chart of accounts. Nothing is sent to Xero yet.
CREATE TABLE "XeroSettings" (
    "organizationId" UUID NOT NULL,
    "sendFrom" DATE,
    "salesAccountId" TEXT,
    "salesTaxType" TEXT,
    "salesAccounts" JSONB NOT NULL DEFAULT '{}',
    "paymentAccounts" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroSettings_pkey" PRIMARY KEY ("organizationId")
);

ALTER TABLE "XeroSettings" ADD CONSTRAINT "XeroSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "XeroSettings" ADD CONSTRAINT "XeroSettings_maps_are_objects" CHECK (
  jsonb_typeof("salesAccounts") = 'object' AND jsonb_typeof("paymentAccounts") = 'object'
);

ALTER TABLE "XeroSettings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "XeroSettings"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
