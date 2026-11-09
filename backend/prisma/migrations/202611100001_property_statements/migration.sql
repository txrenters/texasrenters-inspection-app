-- A property's statement (2026-11-10, phase 3 of the invoice gap review): its
-- billing history, downloaded or emailed to the client, as Jobber's client
-- page sends one. Additive.

-- Jobber's statement settings: the order of the billing history, and the text
-- at the foot of every statement. A row made before these existed takes
-- Jobber's order, newest first, and no text.
ALTER TABLE "InvoiceSettings" ADD COLUMN "statementNewestFirst" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "InvoiceSettings" ADD COLUMN "statementDisclaimer" TEXT;
ALTER TABLE "InvoiceSettings" ADD COLUMN "statementSettingsUpdatedAt" TIMESTAMP(3);

ALTER TABLE "InvoiceSettings" ADD CONSTRAINT "InvoiceSettings_statement_disclaimer_length" CHECK (
  "statementDisclaimer" IS NULL OR char_length("statementDisclaimer") <= 4000
);

-- A statement is about a property, not one invoice: its email has a property
-- and no invoice; every other email still has an invoice.
ALTER TABLE "InvoiceDelivery" ALTER COLUMN "invoiceId" DROP NOT NULL;
ALTER TABLE "InvoiceDelivery" ADD COLUMN "propertywareBuildingId" UUID;

ALTER TABLE "InvoiceDelivery" DROP CONSTRAINT "InvoiceDelivery_kind_known";
ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT "InvoiceDelivery_kind_known" CHECK (
  ("kind" = 'INVOICE' AND "followUpDay" IS NULL AND "paymentId" IS NULL AND "invoiceId" IS NOT NULL)
  OR ("kind" = 'FOLLOW_UP' AND "followUpDay" BETWEEN 0 AND 60 AND "paymentId" IS NULL AND "invoiceId" IS NOT NULL)
  OR ("kind" = 'RECEIPT' AND "followUpDay" IS NULL AND "invoiceId" IS NOT NULL)
  OR ("kind" = 'STATEMENT' AND "followUpDay" IS NULL AND "paymentId" IS NULL AND "invoiceId" IS NULL AND "propertywareBuildingId" IS NOT NULL)
);

ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT "InvoiceDelivery_propertywareBuildingId_fkey" FOREIGN KEY ("propertywareBuildingId") REFERENCES "propertyware_buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "InvoiceDelivery_propertywareBuildingId_createdAt_idx" ON "InvoiceDelivery"("propertywareBuildingId", "createdAt");
