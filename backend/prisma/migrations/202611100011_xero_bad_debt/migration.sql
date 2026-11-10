-- Bad debt in each company's books (2026-11-10): an invoice the office closes
-- as bad debt is written off in its organisation's books in Xero -- a credit
-- note for what is still owed, to the account the office chooses for bad
-- debts, allocated to the invoice, so Xero stops counting it as owed.
-- Reopening it here takes the allocation off and voids the credit note.

-- The account bad debts are written off to: an expense account of the organisation's.
ALTER TABLE "XeroSettings" ADD COLUMN "badDebtAccountId" TEXT;

-- One row per invoice written off in Xero, or refused there, with Xero's reason.
CREATE TABLE "XeroWriteOffSync" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "xeroTenantId" TEXT NOT NULL,
    "xeroCreditNoteId" TEXT,
    "xeroAllocationId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "problem" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroWriteOffSync_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "XeroWriteOffSync_invoiceId_key" ON "XeroWriteOffSync"("invoiceId");
CREATE INDEX "XeroWriteOffSync_organizationId_xeroTenantId_status_idx" ON "XeroWriteOffSync"("organizationId", "xeroTenantId", "status");

ALTER TABLE "XeroWriteOffSync" ADD CONSTRAINT "XeroWriteOffSync_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "XeroWriteOffSync" ADD CONSTRAINT "XeroWriteOffSync_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "XeroWriteOffSync" ADD CONSTRAINT "XeroWriteOffSync_organizationId_xeroTenantId_fkey"
  FOREIGN KEY ("organizationId", "xeroTenantId") REFERENCES "XeroOrganisation"("organizationId", "xeroTenantId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "XeroWriteOffSync" ADD CONSTRAINT "XeroWriteOffSync_status_known" CHECK ("status" IN ('SENT', 'FAILED'));
ALTER TABLE "XeroWriteOffSync" ADD CONSTRAINT "XeroWriteOffSync_attempts_counted" CHECK ("attempts" >= 0);
ALTER TABLE "XeroWriteOffSync" ADD CONSTRAINT "XeroWriteOffSync_amount_owed" CHECK ("amountCents" > 0);
-- Written off: Xero's credit note, allocated to the invoice.
ALTER TABLE "XeroWriteOffSync" ADD CONSTRAINT "XeroWriteOffSync_sent_has_credit_note" CHECK ("status" <> 'SENT' OR "xeroCreditNoteId" IS NOT NULL);

ALTER TABLE "XeroWriteOffSync" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "XeroWriteOffSync"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
