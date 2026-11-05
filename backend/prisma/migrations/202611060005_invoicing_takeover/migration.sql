-- When the console took invoicing over from Jobber, and who did it
-- (2026-11-06, phase 8 of taking invoicing over from Jobber). From then on
-- Jobber's invoices and payments are no longer read -- a read would overwrite
-- what the office now changes in the console -- and the console makes and
-- changes them. Kept with the invoice settings rather than the Jobber
-- connection, so leaving Jobber later never undoes it. Additive.

ALTER TABLE "InvoiceSettings" ADD COLUMN "invoicingTakenOverAt" TIMESTAMP(3);
ALTER TABLE "InvoiceSettings" ADD COLUMN "invoicingTakenOverById" UUID;

ALTER TABLE "InvoiceSettings" ADD CONSTRAINT "InvoiceSettings_invoicingTakenOverById_fkey" FOREIGN KEY ("invoicingTakenOverById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Nobody took it over without a when.
ALTER TABLE "InvoiceSettings" ADD CONSTRAINT "InvoiceSettings_takeover_known" CHECK (
  "invoicingTakenOverById" IS NULL OR "invoicingTakenOverAt" IS NOT NULL
);
