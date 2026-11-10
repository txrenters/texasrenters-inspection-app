-- Which company's books an invoice goes to (2026-11-10, phase 3 of the
-- multi-company plan): one invoice per company, each sent only to its own Xero
-- organisation. Worked out from its lines' products, which the office sends to
-- an organisation on its products and services list, or chosen when no line
-- says. Null for an invoice that belongs to no company: one read from Jobber,
-- or one whose products go to none yet. Such an invoice is never sent.
ALTER TABLE "Invoice" ADD COLUMN "xeroTenantId" TEXT;

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_xeroTenantId_fkey"
  FOREIGN KEY ("organizationId", "xeroTenantId") REFERENCES "XeroOrganisation"("organizationId", "xeroTenantId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- What each organisation's sending looks at: its invoices, from the start date.
CREATE INDEX "Invoice_organizationId_xeroTenantId_issuedOn_idx" ON "Invoice"("organizationId", "xeroTenantId", "issuedOn");
