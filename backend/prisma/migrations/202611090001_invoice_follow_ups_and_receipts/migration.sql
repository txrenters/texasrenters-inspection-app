-- What Jobber did for the office on its own and stops doing at Take over
-- (2026-11-09, phase 1 of the invoice gap review): follow-up emails about
-- unpaid invoices, on the due date and four days after, and receipt emails.
-- Additive.

-- The office's choices. A row made before these existed takes Jobber's.
ALTER TABLE "InvoiceSettings" ADD COLUMN "followUpsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "InvoiceSettings" ADD COLUMN "followUpDays" INTEGER[] NOT NULL DEFAULT ARRAY[0, 4]::INTEGER[];
ALTER TABLE "InvoiceSettings" ADD COLUMN "receiptsAutomatic" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "InvoiceSettings" ADD COLUMN "emailSettingsUpdatedAt" TIMESTAMP(3);

ALTER TABLE "InvoiceSettings" ADD CONSTRAINT "InvoiceSettings_follow_up_days_known" CHECK (
  cardinality("followUpDays") <= 4
  AND 0 <= ALL ("followUpDays")
  AND 60 >= ALL ("followUpDays")
);

-- What each email was for. Every one already sent was an invoice.
ALTER TABLE "InvoiceDelivery" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'INVOICE';
ALTER TABLE "InvoiceDelivery" ADD COLUMN "followUpDay" INTEGER;
ALTER TABLE "InvoiceDelivery" ADD COLUMN "paymentId" UUID;

ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT "InvoiceDelivery_kind_known" CHECK (
  ("kind" = 'INVOICE' AND "followUpDay" IS NULL AND "paymentId" IS NULL)
  OR ("kind" = 'FOLLOW_UP' AND "followUpDay" BETWEEN 0 AND 60 AND "paymentId" IS NULL)
  OR ("kind" = 'RECEIPT' AND "followUpDay" IS NULL)
);

ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT "InvoiceDelivery_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "InvoicePayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "InvoiceDelivery_paymentId_idx" ON "InvoiceDelivery"("paymentId");
