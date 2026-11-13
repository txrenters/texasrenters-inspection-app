-- Draft invoices automatically (2026-11-13). The office turns it on in
-- Invoices -> Settings; from that moment each finished visit is invoiced by
-- itself, by the office's rules, within about ten minutes, and goes to its
-- company's books in Xero as a draft for accounting to check. Null: off.
-- Additive: nullable columns, a foreign key, checks and an index.

-- AlterTable
ALTER TABLE "InvoiceSettings" ADD COLUMN     "autoDraftsFrom" TIMESTAMP(3),
ADD COLUMN     "autoDraftsUpdatedAt" TIMESTAMP(3);

-- A rule may bill another product from a size of property on: pest control on
-- a house of 2,000 sq ft or more is its own item in Crystal Creek Pest's books.
-- AlterTable
ALTER TABLE "InvoiceBillingRule" ADD COLUMN     "largeFromSqFt" INTEGER,
ADD COLUMN     "largeProductId" UUID;

-- CreateIndex
CREATE INDEX "InvoiceBillingRule_largeProductId_idx" ON "InvoiceBillingRule"("largeProductId");

-- AddForeignKey
ALTER TABLE "InvoiceBillingRule" ADD CONSTRAINT "InvoiceBillingRule_organizationId_largeProductId_fkey" FOREIGN KEY ("organizationId", "largeProductId") REFERENCES "InvoiceProduct"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Both or neither, and a size a house can have.
ALTER TABLE "InvoiceBillingRule" ADD CONSTRAINT "InvoiceBillingRule_large_both_or_neither" CHECK (("largeFromSqFt" IS NULL) = ("largeProductId" IS NULL));
ALTER TABLE "InvoiceBillingRule" ADD CONSTRAINT "InvoiceBillingRule_large_from_size" CHECK ("largeFromSqFt" IS NULL OR "largeFromSqFt" BETWEEN 1 AND 100000);
