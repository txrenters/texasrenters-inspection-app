-- Each invoice keeps the Jobber property it is for (2026-11-05), so one that
-- bills no visit the console has -- most of Jobber's older invoices -- is still
-- put on its property's page, through that property's JobberPropertyLink.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "jobberPropertyId" TEXT;

-- CreateIndex
CREATE INDEX "Invoice_organizationId_jobberPropertyId_idx" ON "Invoice"("organizationId", "jobberPropertyId");

-- Read every invoice once more, from the start, so the ones read before this
-- column existed pick up their property. Jobber's API is not billed, and each
-- invoice is replaced whole, so reading one again changes nothing else.
UPDATE "JobberConnection"
   SET "invoiceReadCursor" = NULL,
       "invoiceReadStartedAt" = NULL,
       "invoiceReadCompletedAt" = NULL,
       "invoiceReadThrough" = NULL
 WHERE "invoiceReadStartedAt" IS NOT NULL;
