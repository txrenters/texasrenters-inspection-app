-- Invoices and the payments recorded against them, in the console (the office,
-- 2026-11-05). Jobber is the record: rows read from Jobber are its copy, and a
-- row made in the console is the invoice or payment the console sends Jobber.
-- Additive only. Money is whole cents.

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'AWAITING_PAYMENT', 'PAID', 'BAD_DEBT', 'VOIDED');

-- CreateEnum
CREATE TYPE "InvoicePaymentMethod" AS ENUM ('PROPERTYWARE_LEDGER', 'CHECK', 'CASH', 'BANK_TRANSFER', 'CARD', 'OTHER');

-- CreateEnum
CREATE TYPE "InvoiceOrigin" AS ENUM ('JOBBER', 'CONSOLE');

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "origin" "InvoiceOrigin" NOT NULL,
    "jobberInvoiceId" TEXT,
    "jobberClientId" TEXT,
    "number" TEXT,
    "subject" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL,
    "clientName" TEXT NOT NULL,
    "billingAddress" TEXT,
    "inspectionId" UUID,
    "propertywareBuildingId" UUID,
    "jobberJobId" TEXT,
    "jobNumber" TEXT,
    "issuedOn" DATE,
    "dueOn" DATE,
    "paymentTermsDays" INTEGER,
    "subtotalCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL,
    "balanceCents" INTEGER NOT NULL,
    "clientMessage" TEXT,
    "jobberWebUrl" TEXT,
    "jobberUpdatedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3),
    "createdById" UUID,
    "clientRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoicePayment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "origin" "InvoiceOrigin" NOT NULL,
    "jobberPaymentId" TEXT,
    "paidOn" DATE NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "method" "InvoicePaymentMethod" NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "recordedById" UUID,
    "clientRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Invoice_organizationId_status_dueOn_idx" ON "Invoice"("organizationId", "status", "dueOn");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_issuedOn_idx" ON "Invoice"("organizationId", "issuedOn");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_jobberClientId_idx" ON "Invoice"("organizationId", "jobberClientId");

-- CreateIndex
CREATE INDEX "Invoice_inspectionId_idx" ON "Invoice"("inspectionId");

-- CreateIndex
CREATE INDEX "Invoice_propertywareBuildingId_idx" ON "Invoice"("propertywareBuildingId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_organizationId_jobberInvoiceId_key" ON "Invoice"("organizationId", "jobberInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_organizationId_clientRequestId_key" ON "Invoice"("organizationId", "clientRequestId");

-- CreateIndex
CREATE INDEX "InvoiceLine_organizationId_name_idx" ON "InvoiceLine"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_invoiceId_position_key" ON "InvoiceLine"("invoiceId", "position");

-- CreateIndex
CREATE INDEX "InvoicePayment_organizationId_paidOn_idx" ON "InvoicePayment"("organizationId", "paidOn");

-- CreateIndex
CREATE INDEX "InvoicePayment_invoiceId_idx" ON "InvoicePayment"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePayment_organizationId_jobberPaymentId_key" ON "InvoicePayment"("organizationId", "jobberPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePayment_organizationId_clientRequestId_key" ON "InvoicePayment"("organizationId", "clientRequestId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_propertywareBuildingId_fkey" FOREIGN KEY ("propertywareBuildingId") REFERENCES "propertyware_buildings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A row read from Jobber carries Jobber's id; one made here may not yet.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_jobber_row_has_jobber_id" CHECK ("origin" <> 'JOBBER' OR "jobberInvoiceId" IS NOT NULL);
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_jobber_row_has_jobber_id" CHECK ("origin" <> 'JOBBER' OR "jobberPaymentId" IS NOT NULL);

-- What the console writes is held to the console's own rules. Jobber's copy is
-- taken as Jobber has it, so a figure Jobber allows never blocks the copy.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_console_amounts" CHECK (
  "origin" <> 'CONSOLE' OR ("subtotalCents" >= 0 AND "taxCents" >= 0 AND "totalCents" > 0 AND "balanceCents" >= 0 AND "balanceCents" <= "totalCents")
);
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_console_amount" CHECK ("origin" <> 'CONSOLE' OR "amountCents" > 0);
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_position" CHECK ("position" >= 0);

ALTER TABLE "Invoice" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Invoice"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "InvoiceLine" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "InvoiceLine"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "InvoicePayment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "InvoicePayment"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
