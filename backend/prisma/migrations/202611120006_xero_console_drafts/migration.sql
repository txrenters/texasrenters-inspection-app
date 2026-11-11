-- The console's own invoices go to Xero as complete drafts, each made once
-- (2026-11-12, PR 4 of the plan to make invoices in the console with Xero as
-- the record). A send is written down before the call, PENDING until Xero
-- answers: one whose answer was lost is looked for in Xero before it is sent
-- again, so it is never made twice.
ALTER TABLE "XeroInvoiceSync" DROP CONSTRAINT "XeroInvoiceSync_status_known";
ALTER TABLE "XeroInvoiceSync" ADD CONSTRAINT "XeroInvoiceSync_status_known" CHECK ("status" IN ('SENT', 'FAILED', 'PENDING'));
