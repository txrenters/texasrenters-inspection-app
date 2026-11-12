-- The New invoice laid out as Xero's (2026-11-13, PR B): what the form chose
-- is kept on the invoice and its lines, and Xero is sent it as it is. Every
-- column is new and empty, so every invoice made before goes as it did.

ALTER TABLE "Invoice" ADD COLUMN "xeroReference" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "xeroTaxMode" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "xeroDatesChosen" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_xero_tax_mode_known" CHECK ("xeroTaxMode" IS NULL OR "xeroTaxMode" IN ('EXCLUSIVE', 'INCLUSIVE', 'NO_TAX'));
-- Xero takes a reference of up to 255 characters.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_xero_reference_fits" CHECK ("xeroReference" IS NULL OR length("xeroReference") <= 255);
-- Only the console's own are made on the form.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_xero_form_console_only" CHECK (
  "origin" = 'CONSOLE' OR ("xeroReference" IS NULL AND "xeroTaxMode" IS NULL AND "xeroDatesChosen" = false)
);

ALTER TABLE "InvoiceLine" ADD COLUMN "discountRate" DOUBLE PRECISION;
ALTER TABLE "InvoiceLine" ADD COLUMN "xeroAccountId" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "xeroItemCode" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "xeroTaxType" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "xeroTracking" JSONB;
ALTER TABLE "InvoiceLine" ADD COLUMN "xeroProjectId" TEXT;

ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_discount_percent" CHECK ("discountRate" IS NULL OR ("discountRate" >= 0 AND "discountRate" <= 100));
-- One option in each of Xero's two tracking categories, at most.
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_xero_tracking_list" CHECK (
  "xeroTracking" IS NULL OR (jsonb_typeof("xeroTracking") = 'array' AND jsonb_array_length("xeroTracking") <= 2)
);
