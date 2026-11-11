-- Each company's books read back from Xero (2026-11-12, PR 2 of the plan to
-- make invoices in the console with Xero as the source of truth). Xero's own
-- invoices and payments are kept as rows of their own -- origin XERO -- out of
-- sight until the pages show them (PR 3); an invoice the console made and sent
-- is brought up to date in place. Additive: one enum value, nullable columns,
-- indexes, and checks that a row from Xero carries Xero's id.

-- AlterEnum
ALTER TYPE "InvoiceOrigin" ADD VALUE 'XERO';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "xeroInvoiceId" TEXT,
ADD COLUMN     "xeroContactId" TEXT,
ADD COLUMN     "xeroStatus" TEXT,
ADD COLUMN     "xeroUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "xeroUrl" TEXT,
ADD COLUMN     "amountPaidCents" INTEGER,
ADD COLUMN     "amountCreditedCents" INTEGER;

-- AlterTable
ALTER TABLE "InvoicePayment" ADD COLUMN     "xeroPaymentId" TEXT;

-- AlterTable
ALTER TABLE "XeroSettings" ADD COLUMN     "booksInvoicesSince" TIMESTAMP(3),
ADD COLUMN     "booksInvoicesPage" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "booksPaymentsSince" TIMESTAMP(3),
ADD COLUMN     "booksPaymentsPage" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "booksReadAt" TIMESTAMP(3),
ADD COLUMN     "booksLastRunAt" TIMESTAMP(3),
ADD COLUMN     "booksLastRunProblem" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_organizationId_xeroTenantId_xeroInvoiceId_key" ON "Invoice"("organizationId", "xeroTenantId", "xeroInvoiceId");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_number_idx" ON "Invoice"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePayment_organizationId_xeroPaymentId_key" ON "InvoicePayment"("organizationId", "xeroPaymentId");

-- CreateIndex
CREATE INDEX "XeroInvoiceSync_organizationId_xeroTenantId_xeroInvoiceId_idx" ON "XeroInvoiceSync"("organizationId", "xeroTenantId", "xeroInvoiceId");

-- CreateIndex
CREATE INDEX "XeroPaymentSync_organizationId_xeroPaymentId_idx" ON "XeroPaymentSync"("organizationId", "xeroPaymentId");

-- CreateIndex
CREATE INDEX "XeroContactLink_organizationId_xeroTenantId_xeroContactId_idx" ON "XeroContactLink"("organizationId", "xeroTenantId", "xeroContactId");

-- A row from Xero carries Xero's id, and an id from Xero its company. 'XERO'
-- itself is not named here: a value added to an enum cannot be used in the
-- transaction that adds it.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_xero_row_has_xero_id" CHECK ("origin" IN ('JOBBER', 'CONSOLE') OR "xeroInvoiceId" IS NOT NULL);
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_xero_id_has_company" CHECK ("xeroInvoiceId" IS NULL OR "xeroTenantId" IS NOT NULL);
-- Nothing from Xero is written onto Jobber's copy: Xero's invoice is a row of its own.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_jobber_row_has_no_xero_id" CHECK ("origin" <> 'JOBBER' OR "xeroInvoiceId" IS NULL);
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_xero_row_has_xero_id" CHECK ("origin" IN ('JOBBER', 'CONSOLE') OR "xeroPaymentId" IS NOT NULL);
ALTER TABLE "XeroSettings" ADD CONSTRAINT "XeroSettings_books_pages" CHECK ("booksInvoicesPage" >= 1 AND "booksPaymentsPage" >= 1);

-- A console invoice in Xero is Xero's, as Xero has it: its amounts are taken
-- as they are there, as Jobber's copy takes Jobber's.
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_console_amounts";
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_console_amounts" CHECK (
  "origin" <> 'CONSOLE' OR "xeroInvoiceId" IS NOT NULL OR ("subtotalCents" >= 0 AND "taxCents" >= 0 AND "totalCents" > 0 AND "balanceCents" >= 0 AND "balanceCents" <= "totalCents")
);
