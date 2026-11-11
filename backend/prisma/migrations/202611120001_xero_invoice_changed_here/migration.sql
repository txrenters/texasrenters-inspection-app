-- Each invoice goes to Xero once (2026-11-12): once it is there it is the
-- office's, and the console never sends it again. One changed here after it
-- went is marked with when, for the office to make the same change in Xero.
ALTER TABLE "XeroInvoiceSync" ADD COLUMN "changedHereAt" TIMESTAMP(3);
