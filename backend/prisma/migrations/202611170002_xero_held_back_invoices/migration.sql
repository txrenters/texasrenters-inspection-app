-- Invoices the console held back (2026-11-17). An invoice the console would
-- not send as it is -- its lines do not come to its total, or its company's
-- books in Xero lacked a tracking option, account, item or tax rate as last
-- read -- is now marked held back, apart from one Xero refused. One held for
-- what the books lacked says which part of them it waits on; the console reads
-- those parts again from Xero at most once an hour, and sends it once they
-- have what it needs, with no button pressed.
-- Additive: two columns on XeroInvoiceSync, one on XeroOrganisation, checks.

-- AlterTable
ALTER TABLE "XeroInvoiceSync" ADD COLUMN     "heldBack" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "waitsOn" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "XeroOrganisation" ADD COLUMN     "catalogRecheckedAt" TIMESTAMP(3);

-- Only the parts of the books the console reads; only on one held back; only held back while not sent.
ALTER TABLE "XeroInvoiceSync" ADD CONSTRAINT "XeroInvoiceSync_waits_on_known" CHECK ("waitsOn" <@ ARRAY['ACCOUNTS', 'TRACKING', 'ITEMS', 'TAX_RATES']::TEXT[]);
ALTER TABLE "XeroInvoiceSync" ADD CONSTRAINT "XeroInvoiceSync_waits_when_held" CHECK (cardinality("waitsOn") = 0 OR "heldBack");
ALTER TABLE "XeroInvoiceSync" ADD CONSTRAINT "XeroInvoiceSync_held_is_failed" CHECK (NOT "heldBack" OR "status" = 'FAILED');

-- Held back before today: the console's own holds are the ones never tried again on a timer, of invoices not in Xero.
UPDATE "XeroInvoiceSync" SET "heldBack" = true WHERE "status" = 'FAILED' AND "nextAttemptAt" IS NULL AND "xeroInvoiceId" IS NULL;

-- The console's own invoices among them are looked at once more by the next run, as "Try the refused again" would:
-- one whose company's books now have what it needs goes, and the rest are held again saying what each waits on.
UPDATE "XeroInvoiceSync" s
   SET "nextAttemptAt" = now()
  FROM "Invoice" i
 WHERE i."id" = s."invoiceId"
   AND i."origin" = 'CONSOLE'
   AND i."xeroInvoiceId" IS NULL
   AND s."heldBack"
   AND s."nextAttemptAt" IS NULL;
