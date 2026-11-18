-- Purchasing (2026-11-19, phase 2 of the inventory and purchasing plan): the
-- purchase requisition. Somebody asks for stock and says why; somebody else
-- approves it, sends it back or rejects it. It moves no stock and spends
-- nothing. Nothing here is called from anything billed.

CREATE TYPE "PurchaseRequisitionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'SENT_BACK', 'APPROVED', 'REJECTED', 'CANCELLED');

-- The next number of each kind of document an office numbers.
CREATE TABLE "DocumentSeries" (
    "organizationId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DocumentSeries_pkey" PRIMARY KEY ("organizationId", "kind")
);
ALTER TABLE "DocumentSeries" ADD CONSTRAINT "DocumentSeries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentSeries" ADD CONSTRAINT "DocumentSeries_next_is_a_number" CHECK ("next" >= 1);

CREATE TABLE "PurchasingSettings" (
    "organizationId" UUID NOT NULL,
    "approvalLimitCents" INTEGER NOT NULL DEFAULT 50000,
    "quotesAboveLimit" INTEGER NOT NULL DEFAULT 2,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchasingSettings_pkey" PRIMARY KEY ("organizationId")
);
ALTER TABLE "PurchasingSettings" ADD CONSTRAINT "PurchasingSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchasingSettings" ADD CONSTRAINT "PurchasingSettings_not_negative" CHECK ("approvalLimitCents" >= 0 AND "quotesAboveLimit" >= 0);

CREATE TABLE "PurchaseRequisition" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT,
    "status" "PurchaseRequisitionStatus" NOT NULL DEFAULT 'DRAFT',
    "xeroTenantId" TEXT,
    "neededBy" DATE,
    "deliverToPlaceId" UUID,
    "reason" TEXT NOT NULL,
    "requestedById" UUID NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseRequisition_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PurchaseRequisition_organizationId_number_key" ON "PurchaseRequisition"("organizationId", "number");
CREATE UNIQUE INDEX "PurchaseRequisition_organizationId_id_key" ON "PurchaseRequisition"("organizationId", "id");
CREATE INDEX "PurchaseRequisition_organizationId_status_createdAt_idx" ON "PurchaseRequisition"("organizationId", "status", "createdAt");
CREATE INDEX "PurchaseRequisition_organizationId_requestedById_createdAt_idx" ON "PurchaseRequisition"("organizationId", "requestedById", "createdAt");
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A company and a place of its own office.
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_organizationId_xeroTenantId_fkey" FOREIGN KEY ("organizationId", "xeroTenantId") REFERENCES "XeroOrganisation"("organizationId", "xeroTenantId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_organizationId_deliverToPlaceId_fkey" FOREIGN KEY ("organizationId", "deliverToPlaceId") REFERENCES "StockPlace"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
-- The people on a requisition are part of its record: neither is removed from under it.
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Nobody decides their own requisition, whatever the application does.
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_not_decided_by_its_requester" CHECK ("decidedById" IS NULL OR "decidedById" <> "requestedById");
-- Approved, sent back and rejected are decisions: each has who made it and when.
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_a_decision_has_its_decider" CHECK (
    "status" NOT IN ('APPROVED', 'SENT_BACK', 'REJECTED') OR ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)
);
-- Everything past a draft has been submitted, and so has its number. A draft may be cancelled without one.
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_submitted_has_its_number" CHECK (
    "status" IN ('DRAFT', 'CANCELLED') OR ("number" IS NOT NULL AND "submittedAt" IS NOT NULL)
);

CREATE TABLE "PurchaseRequisitionLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "requisitionId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "itemId" UUID,
    "description" TEXT,
    "quantity" INTEGER NOT NULL,
    "estimatedUnitCostCents" INTEGER NOT NULL,

    CONSTRAINT "PurchaseRequisitionLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PurchaseRequisitionLine_organizationId_requisitionId_position_idx" ON "PurchaseRequisitionLine"("organizationId", "requisitionId", "position");
ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_organizationId_requisitionId_fkey" FOREIGN KEY ("organizationId", "requisitionId") REFERENCES "PurchaseRequisition"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_organizationId_itemId_fkey" FOREIGN KEY ("organizationId", "itemId") REFERENCES "StockItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_asks_for_something" CHECK ("quantity" > 0 AND "estimatedUnitCostCents" >= 0);
-- An item of the inventory, or words for something that is not on the list yet.
ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_names_what_it_asks_for" CHECK ("itemId" IS NOT NULL OR length(trim(coalesce("description", ''))) > 0);

CREATE TABLE "PurchaseRequisitionQuote" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "requisitionId" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "delivery" TEXT,
    "chosen" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PurchaseRequisitionQuote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PurchaseRequisitionQuote_organizationId_requisitionId_idx" ON "PurchaseRequisitionQuote"("organizationId", "requisitionId");
-- One chosen quote a requisition, at most.
CREATE UNIQUE INDEX "PurchaseRequisitionQuote_one_chosen" ON "PurchaseRequisitionQuote"("requisitionId") WHERE "chosen";
ALTER TABLE "PurchaseRequisitionQuote" ADD CONSTRAINT "PurchaseRequisitionQuote_organizationId_requisitionId_fkey" FOREIGN KEY ("organizationId", "requisitionId") REFERENCES "PurchaseRequisition"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequisitionQuote" ADD CONSTRAINT "PurchaseRequisitionQuote_organizationId_vendorId_fkey" FOREIGN KEY ("organizationId", "vendorId") REFERENCES "Vendor"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequisitionQuote" ADD CONSTRAINT "PurchaseRequisitionQuote_total_not_negative" CHECK ("totalCents" >= 0);

ALTER TABLE "DocumentSeries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DocumentSeries"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "PurchasingSettings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PurchasingSettings"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "PurchaseRequisition" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PurchaseRequisition"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "PurchaseRequisitionLine" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PurchaseRequisitionLine"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "PurchaseRequisitionQuote" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PurchaseRequisitionQuote"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
