-- An invoice sent to the client from the console (2026-11-06, phase 5 of
-- taking invoicing over from Jobber): to whom, when, by whom, and whether it
-- went. Made before the email is sent and keyed by the browser, so a double
-- click sends one; counted for the office's daily ceiling on email. Additive.

CREATE TABLE "InvoiceDelivery" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "recipients" TEXT[],
    "message" TEXT,
    "status" TEXT NOT NULL,
    "failure" TEXT,
    "sentById" UUID,
    "clientRequestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "InvoiceDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InvoiceDelivery_organizationId_clientRequestId_key" ON "InvoiceDelivery"("organizationId", "clientRequestId");
CREATE INDEX "InvoiceDelivery_organizationId_createdAt_idx" ON "InvoiceDelivery"("organizationId", "createdAt");
CREATE INDEX "InvoiceDelivery_invoiceId_createdAt_idx" ON "InvoiceDelivery"("invoiceId", "createdAt");

ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT "InvoiceDelivery_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT "InvoiceDelivery_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What the console writes is held to its own rules.
ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT "InvoiceDelivery_known" CHECK (
  "channel" IN ('EMAIL') AND "status" IN ('PENDING', 'SENT', 'FAILED') AND cardinality("recipients") BETWEEN 1 AND 5
);

ALTER TABLE "InvoiceDelivery" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "InvoiceDelivery"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
