-- Which company's books a product or service goes to (2026-11-10, phase 2 of
-- the multi-company plan): the office chooses, on its products and services
-- list, the Xero organisation each one belongs to -- filter change to one,
-- pest control to another. Null until chosen. An organisation is never
-- deleted (it is marked removed), so a choice always names one the office had.
ALTER TABLE "InvoiceProduct" ADD COLUMN "xeroTenantId" TEXT;

ALTER TABLE "InvoiceProduct" ADD CONSTRAINT "InvoiceProduct_organizationId_xeroTenantId_fkey"
  FOREIGN KEY ("organizationId", "xeroTenantId") REFERENCES "XeroOrganisation"("organizationId", "xeroTenantId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE INDEX "InvoiceProduct_organizationId_xeroTenantId_idx" ON "InvoiceProduct"("organizationId", "xeroTenantId");
