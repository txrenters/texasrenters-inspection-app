-- The office's invoice settings (2026-11-06, phase 6 of taking invoicing over
-- from Jobber): the company details its invoices, receipts and emails print,
-- what a new invoice starts with, and its products and services at its own
-- prices. Until now the console guessed them -- the company from the server's
-- environment, the wording from the latest invoice, the prices from six
-- months of billing. A blank setting still falls back to that. Additive.

CREATE TABLE "InvoiceSettings" (
    "organizationId" UUID NOT NULL,
    "companyName" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "defaultSubject" TEXT,
    "defaultTermsDays" INTEGER,
    "defaultClientMessage" TEXT,
    "defaultContractDisclaimer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceSettings_pkey" PRIMARY KEY ("organizationId")
);

ALTER TABLE "InvoiceSettings" ADD CONSTRAINT "InvoiceSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The terms the console offers, as Jobber's list has them.
ALTER TABLE "InvoiceSettings" ADD CONSTRAINT "InvoiceSettings_known_terms" CHECK (
  "defaultTermsDays" IS NULL OR "defaultTermsDays" IN (0, 7, 15, 30, 45, 60)
);

CREATE TABLE "InvoiceProduct" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "description" TEXT,
    "unitPriceCents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceProduct_pkey" PRIMARY KEY ("id")
);

-- One entry per name, whatever its case: "Filter change" is "Filter Change".
CREATE UNIQUE INDEX "InvoiceProduct_organizationId_nameKey_key" ON "InvoiceProduct"("organizationId", "nameKey");
CREATE INDEX "InvoiceProduct_organizationId_active_idx" ON "InvoiceProduct"("organizationId", "active");

ALTER TABLE "InvoiceProduct" ADD CONSTRAINT "InvoiceProduct_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InvoiceProduct" ADD CONSTRAINT "InvoiceProduct_known" CHECK (
  length(btrim("name")) > 0
  AND "nameKey" = lower(btrim("name"))
  AND "unitPriceCents" BETWEEN 0 AND 100000000
);

ALTER TABLE "InvoiceSettings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "InvoiceSettings"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "InvoiceProduct" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "InvoiceProduct"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
