-- The invoice itself (2026-11-10, phase 4 of the invoice gap review). Additive.

-- Jobber's "Client view": what the client sees on the invoice's PDF and
-- email. Every invoice so far showed all of it.
ALTER TABLE "Invoice" ADD COLUMN "showQuantities" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Invoice" ADD COLUMN "showUnitPrices" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Invoice" ADD COLUMN "showLineTotals" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Invoice" ADD COLUMN "showAccountBalance" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Invoice" ADD COLUMN "showLateStamp" BOOLEAN NOT NULL DEFAULT true;

-- Notes written in the console, beside the ones read from Jobber. A re-read
-- of Jobber replaces only Jobber's.
ALTER TABLE "InvoiceNote" ALTER COLUMN "jobberNoteId" DROP NOT NULL;
ALTER TABLE "InvoiceNote" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'JOBBER';
ALTER TABLE "InvoiceNote" ADD COLUMN "createdById" UUID;
ALTER TABLE "InvoiceNote" ADD CONSTRAINT "InvoiceNote_origin_known" CHECK (
  ("origin" = 'JOBBER' AND "jobberNoteId" IS NOT NULL)
  OR ("origin" = 'CONSOLE' AND "jobberNoteId" IS NULL)
);
ALTER TABLE "InvoiceNote" ADD CONSTRAINT "InvoiceNote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Files added in the console: kept in the console's storage from the start.
ALTER TABLE "InvoiceFile" ALTER COLUMN "jobberFileId" DROP NOT NULL;
ALTER TABLE "InvoiceFile" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'JOBBER';
ALTER TABLE "InvoiceFile" ADD COLUMN "uploadedById" UUID;
ALTER TABLE "InvoiceFile" ADD CONSTRAINT "InvoiceFile_origin_known" CHECK (
  ("origin" = 'JOBBER' AND "jobberFileId" IS NOT NULL)
  OR ("origin" = 'CONSOLE' AND "jobberFileId" IS NULL AND "storageKey" IS NOT NULL)
);
ALTER TABLE "InvoiceFile" ADD CONSTRAINT "InvoiceFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The office's words for the invoice, receipt and statement emails, and
-- where a client's reply goes. Null keeps the console's own.
ALTER TABLE "InvoiceSettings" ADD COLUMN "emailTemplates" JSONB;
ALTER TABLE "InvoiceSettings" ADD COLUMN "replyToEmail" TEXT;
ALTER TABLE "InvoiceSettings" ADD COLUMN "templatesUpdatedAt" TIMESTAMP(3);
ALTER TABLE "InvoiceSettings" ADD CONSTRAINT "InvoiceSettings_reply_to_length" CHECK ("replyToEmail" IS NULL OR char_length("replyToEmail") <= 254);
