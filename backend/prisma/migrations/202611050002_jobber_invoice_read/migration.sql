-- Reading Jobber's invoices into the console's copy (2026-11-05): how far the
-- read has got, and why it last stopped. Additive and nullable: a connection
-- that has never read an invoice has all six empty.

-- AlterTable
ALTER TABLE "JobberConnection" ADD COLUMN     "invoiceReadCheckedAt" TIMESTAMP(3),
ADD COLUMN     "invoiceReadCompletedAt" TIMESTAMP(3),
ADD COLUMN     "invoiceReadCursor" TEXT,
ADD COLUMN     "invoiceReadProblem" TEXT,
ADD COLUMN     "invoiceReadStartedAt" TIMESTAMP(3),
ADD COLUMN     "invoiceReadThrough" TIMESTAMP(3);

-- The two reasons the console can give for an empty Invoices page.
ALTER TABLE "JobberConnection" ADD CONSTRAINT "JobberConnection_invoice_read_problem"
  CHECK ("invoiceReadProblem" IS NULL OR "invoiceReadProblem" IN ('NOT_PERMITTED', 'FAILED'));
