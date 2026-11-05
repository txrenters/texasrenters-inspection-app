-- Every detail Jobber keeps on an invoice and a payment (2026-11-05: "make sure
-- we get everything, every details"), ahead of the cutover, after which the
-- console keeps them itself. Additive: new columns, two new tables, and the
-- payment methods Jobber offers that the console did not.

-- AlterEnum


ALTER TYPE "InvoicePaymentMethod" ADD VALUE 'ZELLE';
ALTER TYPE "InvoicePaymentMethod" ADD VALUE 'CASH_APP';
ALTER TYPE "InvoicePaymentMethod" ADD VALUE 'PAYPAL';
ALTER TYPE "InvoicePaymentMethod" ADD VALUE 'VENMO';
ALTER TYPE "InvoicePaymentMethod" ADD VALUE 'MONEY_ORDER';

-- AlterTable
ALTER TABLE "JobberConnection" ADD COLUMN     "paymentReadCompletedAt" TIMESTAMP(3),
ADD COLUMN     "paymentReadCursor" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "billingName" TEXT,
ADD COLUMN     "billingSameAsProperty" BOOLEAN,
ADD COLUMN     "clientEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "clientPhones" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "contractDisclaimer" TEXT,
ADD COLUMN     "customFields" JSONB,
ADD COLUMN     "depositCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discountKind" TEXT,
ADD COLUMN     "discountRate" DOUBLE PRECISION,
ADD COLUMN     "jobTitle" TEXT,
ADD COLUMN     "paidOn" DATE,
ADD COLUMN     "propertyAddress" TEXT,
ADD COLUMN     "salespersonName" TEXT,
ADD COLUMN     "taxInclusive" BOOLEAN,
ADD COLUMN     "taxRateName" TEXT,
ADD COLUMN     "taxRatePercent" DOUBLE PRECISION,
ADD COLUMN     "tipsCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "viewedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "category" TEXT,
ADD COLUMN     "productName" TEXT,
ADD COLUMN     "serviceOn" DATE,
ADD COLUMN     "taxable" BOOLEAN;

-- AlterTable
ALTER TABLE "InvoicePayment" ADD COLUMN     "jobberPaymentType" TEXT,
ADD COLUMN     "jobberRecordId" TEXT;

-- CreateTable
CREATE TABLE "InvoiceNote" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "jobberNoteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "writtenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceFile" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "jobberFileId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "jobberUrl" TEXT,
    "storageKey" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceNote_organizationId_idx" ON "InvoiceNote"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceNote_invoiceId_jobberNoteId_key" ON "InvoiceNote"("invoiceId", "jobberNoteId");

-- CreateIndex
CREATE INDEX "InvoiceFile_organizationId_idx" ON "InvoiceFile"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceFile_invoiceId_jobberFileId_key" ON "InvoiceFile"("invoiceId", "jobberFileId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePayment_organizationId_jobberRecordId_key" ON "InvoicePayment"("organizationId", "jobberRecordId");

-- AddForeignKey
ALTER TABLE "InvoiceNote" ADD CONSTRAINT "InvoiceNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceFile" ADD CONSTRAINT "InvoiceFile_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- What the console writes is held to its own rules, as for the amounts before.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_console_extras" CHECK (
  "origin" <> 'CONSOLE' OR ("discountCents" >= 0 AND "depositCents" >= 0 AND "tipsCents" >= 0)
);

ALTER TABLE "InvoiceNote" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "InvoiceNote"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "InvoiceFile" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "InvoiceFile"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

-- Read every invoice once more, from the start, so the ones already read pick
-- up the details added here; and read Jobber's payment list from its start.
UPDATE "JobberConnection"
   SET "invoiceReadCursor" = NULL,
       "invoiceReadStartedAt" = NULL,
       "invoiceReadCompletedAt" = NULL,
       "invoiceReadThrough" = NULL,
       "paymentReadCursor" = NULL,
       "paymentReadCompletedAt" = NULL
 WHERE "invoiceReadStartedAt" IS NOT NULL;
