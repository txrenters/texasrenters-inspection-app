-- Payments to each company's books (2026-11-10, phase 4 of the multi-company
-- plan): a payment recorded against an invoice that is in a Xero organisation
-- goes to that organisation, to the account chosen for how it was paid. One
-- row per payment sent, or refused with Xero's reason, as XeroInvoiceSync
-- keeps one per invoice.
--
-- When the payment is removed from the console the row stays, with no
-- payment, until it is deleted in Xero too: so "paymentId" is set null, not
-- cascaded.
CREATE TABLE "XeroPaymentSync" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "paymentId" UUID,
    "invoiceId" UUID NOT NULL,
    "xeroTenantId" TEXT NOT NULL,
    "xeroPaymentId" TEXT,
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

    CONSTRAINT "XeroPaymentSync_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "XeroPaymentSync_paymentId_key" ON "XeroPaymentSync"("paymentId");
CREATE INDEX "XeroPaymentSync_organizationId_xeroTenantId_status_idx" ON "XeroPaymentSync"("organizationId", "xeroTenantId", "status");
CREATE INDEX "XeroPaymentSync_invoiceId_idx" ON "XeroPaymentSync"("invoiceId");

ALTER TABLE "XeroPaymentSync" ADD CONSTRAINT "XeroPaymentSync_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "XeroPaymentSync" ADD CONSTRAINT "XeroPaymentSync_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "InvoicePayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "XeroPaymentSync" ADD CONSTRAINT "XeroPaymentSync_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "XeroPaymentSync" ADD CONSTRAINT "XeroPaymentSync_organizationId_xeroTenantId_fkey"
  FOREIGN KEY ("organizationId", "xeroTenantId") REFERENCES "XeroOrganisation"("organizationId", "xeroTenantId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "XeroPaymentSync" ADD CONSTRAINT "XeroPaymentSync_status_known" CHECK ("status" IN ('SENT', 'FAILED'));
ALTER TABLE "XeroPaymentSync" ADD CONSTRAINT "XeroPaymentSync_attempts_counted" CHECK ("attempts" >= 0);
-- A sent payment has Xero's id for it.
ALTER TABLE "XeroPaymentSync" ADD CONSTRAINT "XeroPaymentSync_sent_has_id" CHECK ("status" <> 'SENT' OR "xeroPaymentId" IS NOT NULL);

ALTER TABLE "XeroPaymentSync" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "XeroPaymentSync"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
