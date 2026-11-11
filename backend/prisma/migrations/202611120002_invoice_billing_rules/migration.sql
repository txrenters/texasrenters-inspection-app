-- What a finished visit bills (2026-11-12, PR 1 of making invoices in the
-- console, with Xero the books). Each rule: a visit of a type -- or any visit
-- -- on which a service was reported done -- or whatever was done -- bills one
-- product of the office's list, at its price and to its company's books.
-- Learned from past invoices and confirmed by the office; a visit no rule
-- covers is listed with the reason, never billed at $0.

-- A rule names a product of its own office: the pair is what it points at.
CREATE UNIQUE INDEX "InvoiceProduct_organizationId_id_key" ON "InvoiceProduct"("organizationId", "id");

CREATE TABLE "InvoiceBillingRule" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "inspectionType" "InspectionType",
    "service" TEXT,
    "productId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceBillingRule_pkey" PRIMARY KEY ("id")
);

-- One rule per visit type, service and product. NULLS NOT DISTINCT: "any
-- visit" and "whatever was done" are NULL, and two of those must still clash.
-- Prisma cannot express it, so it lives only here; the schema says so.
CREATE UNIQUE INDEX "InvoiceBillingRule_one_rule_key"
    ON "InvoiceBillingRule"("organizationId", "inspectionType", "service", "productId")
    NULLS NOT DISTINCT;
CREATE INDEX "InvoiceBillingRule_productId_idx" ON "InvoiceBillingRule"("productId");

ALTER TABLE "InvoiceBillingRule" ADD CONSTRAINT "InvoiceBillingRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvoiceBillingRule" ADD CONSTRAINT "InvoiceBillingRule_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "InvoiceProduct"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The services a technician reports done (REPORTABLE_VISIT_SERVICES).
ALTER TABLE "InvoiceBillingRule" ADD CONSTRAINT "InvoiceBillingRule_service_known" CHECK ("service" IS NULL OR "service" IN ('filterChange', 'pestControl', 'fleaTreatment'));
-- Says which visits it is for: never every visit at once.
ALTER TABLE "InvoiceBillingRule" ADD CONSTRAINT "InvoiceBillingRule_says_which_visits" CHECK ("inspectionType" IS NOT NULL OR "service" IS NOT NULL);

ALTER TABLE "InvoiceBillingRule" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "InvoiceBillingRule"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
