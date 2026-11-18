-- Vendor bills to Xero (2026-11-19, phase 7 of the inventory and purchasing
-- plan). A company's choices for its bills, and where each bill and its
-- payment stand with Xero. Kept apart from the invoice tables: nothing here
-- changes how invoices are sent. Additive only.

-- The account a company's bills are booked to, and the account each way of
-- paying comes out of: `{ "CHECK": "<account id>", ... }`.
CREATE TABLE "XeroBillSettings" (
    "organizationId" UUID NOT NULL,
    "xeroTenantId" TEXT NOT NULL,
    "purchasesAccountId" TEXT,
    "paymentAccounts" JSONB NOT NULL DEFAULT '{}',
    "updatedByName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroBillSettings_pkey" PRIMARY KEY ("organizationId", "xeroTenantId")
);
ALTER TABLE "XeroBillSettings" ADD CONSTRAINT "XeroBillSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "XeroBillSettings" ADD CONSTRAINT "XeroBillSettings_organizationId_xeroTenantId_fkey" FOREIGN KEY ("organizationId", "xeroTenantId") REFERENCES "XeroOrganisation"("organizationId", "xeroTenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- One row a bill, written before Xero is asked: PENDING is "asked, answer not
-- yet kept", so a lost answer is looked for and the bill never made twice.
CREATE TABLE "VendorBillXero" (
    "billId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "xeroTenantId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "xeroInvoiceId" TEXT,
    "problem" TEXT,
    "sentById" UUID,
    "sentByName" TEXT,
    "sentAt" TIMESTAMP(3),
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentStatus" TEXT,
    "xeroPaymentId" TEXT,
    "paymentProblem" TEXT,
    "paymentSentByName" TEXT,
    "paymentSentAt" TIMESTAMP(3),
    "paymentAttemptedAt" TIMESTAMP(3),

    CONSTRAINT "VendorBillXero_pkey" PRIMARY KEY ("billId")
);
CREATE INDEX "VendorBillXero_organizationId_idx" ON "VendorBillXero"("organizationId");
CREATE UNIQUE INDEX "VendorBillXero_organizationId_billId_key" ON "VendorBillXero"("organizationId", "billId");
-- A bill in Xero is one bill here.
CREATE UNIQUE INDEX "VendorBillXero_xeroInvoiceId_key" ON "VendorBillXero"("organizationId", "xeroTenantId", "xeroInvoiceId");
ALTER TABLE "VendorBillXero" ADD CONSTRAINT "VendorBillXero_organizationId_billId_fkey" FOREIGN KEY ("organizationId", "billId") REFERENCES "VendorBill"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorBillXero" ADD CONSTRAINT "VendorBillXero_status_known" CHECK ("status" IN ('PENDING', 'SENT', 'FAILED') AND ("paymentStatus" IS NULL OR "paymentStatus" IN ('PENDING', 'SENT', 'FAILED')));
-- Sent means Xero's id is kept, with who sent it and when.
ALTER TABLE "VendorBillXero" ADD CONSTRAINT "VendorBillXero_sent_has_its_id" CHECK ("status" <> 'SENT' OR ("xeroInvoiceId" IS NOT NULL AND "sentAt" IS NOT NULL AND "sentByName" IS NOT NULL));
-- A payment goes only against a bill that is in Xero, and sent means its id is kept.
ALTER TABLE "VendorBillXero" ADD CONSTRAINT "VendorBillXero_payment_after_the_bill" CHECK (
    "paymentStatus" IS NULL
    OR ("status" = 'SENT' AND ("paymentStatus" <> 'SENT' OR ("xeroPaymentId" IS NOT NULL AND "paymentSentAt" IS NOT NULL AND "paymentSentByName" IS NOT NULL)))
);

ALTER TABLE "XeroBillSettings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "XeroBillSettings"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "VendorBillXero" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "VendorBillXero"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
