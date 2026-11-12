-- A company whose prices include its sales tax (2026-11-12, PR 5 of the plan
-- to make invoices in the console with Xero as the record): Crystal Creek
-- Pest's $39.00 is $36.03 and $2.97 of tax at 8.25%. On, its lines go to Xero
-- tax-inclusive, so Xero's total is the console's. Off for every company until
-- the office turns it on.
ALTER TABLE "XeroSettings" ADD COLUMN "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT false;
