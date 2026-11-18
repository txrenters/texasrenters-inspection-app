-- Purchase orders (2026-11-19, phase 3 of the inventory and purchasing plan).
-- A purchaser makes an order from an approved requisition; somebody else
-- approves it; it goes to the vendor as a PDF by email. An order moves no
-- stock. The one billed call here is that email: one a press, written down
-- before it is sent, under a daily ceiling.

-- A requisition that has become an order. Added and not used in this
-- migration: a new enum value cannot be used in the transaction that adds it.
ALTER TYPE "PurchaseRequisitionStatus" ADD VALUE IF NOT EXISTS 'ORDERED';

CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SENT', 'CANCELLED');

CREATE TABLE "PurchaseOrder" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "requisitionId" UUID NOT NULL,
    "vendorId" UUID,
    "xeroTenantId" TEXT,
    "deliverToPlaceId" UUID,
    "expectedOn" DATE,
    "terms" TEXT,
    "taxBasisPoints" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" UUID NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "sentAt" TIMESTAMP(3),
    "cancelledById" UUID,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PurchaseOrder_organizationId_number_key" ON "PurchaseOrder"("organizationId", "number");
CREATE UNIQUE INDEX "PurchaseOrder_organizationId_id_key" ON "PurchaseOrder"("organizationId", "id");
CREATE INDEX "PurchaseOrder_organizationId_status_createdAt_idx" ON "PurchaseOrder"("organizationId", "status", "createdAt");
-- A requisition has one order at a time: another can be made only once that one is cancelled.
CREATE UNIQUE INDEX "PurchaseOrder_one_live_order_a_requisition" ON "PurchaseOrder"("requisitionId") WHERE "status" <> 'CANCELLED';
CREATE INDEX "PurchaseOrder_organizationId_requisitionId_idx" ON "PurchaseOrder"("organizationId", "requisitionId");

ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Its requisition, vendor, company and place are its own office's; none is removed from under it.
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_requisitionId_fkey" FOREIGN KEY ("organizationId", "requisitionId") REFERENCES "PurchaseRequisition"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_vendorId_fkey" FOREIGN KEY ("organizationId", "vendorId") REFERENCES "Vendor"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_xeroTenantId_fkey" FOREIGN KEY ("organizationId", "xeroTenantId") REFERENCES "XeroOrganisation"("organizationId", "xeroTenantId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_deliverToPlaceId_fkey" FOREIGN KEY ("organizationId", "deliverToPlaceId") REFERENCES "StockPlace"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Nobody approves an order they made, whatever the application does.
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_not_approved_by_its_maker" CHECK ("approvedById" IS NULL OR "approvedById" <> "createdById");
-- Approved, and so sent, means somebody approved it.
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_approved_has_its_approver" CHECK (
    "status" NOT IN ('APPROVED', 'SENT') OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL)
);
-- Everything past a draft has been submitted: it has its number and its vendor. A draft may be cancelled without.
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_submitted_has_number_and_vendor" CHECK (
    "status" IN ('DRAFT', 'CANCELLED') OR ("number" IS NOT NULL AND "submittedAt" IS NOT NULL AND "vendorId" IS NOT NULL)
);
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_sent_has_when" CHECK ("status" <> 'SENT' OR "sentAt" IS NOT NULL);
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_cancelled_has_who_and_why" CHECK (
    "status" <> 'CANCELLED' OR ("cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL AND length(btrim(coalesce("cancelReason", ''))) > 0)
);
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tax_rate_in_range" CHECK ("taxBasisPoints" BETWEEN 0 AND 3000);

CREATE TABLE "PurchaseOrderLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "itemId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);
-- An item is on an order once.
CREATE UNIQUE INDEX "PurchaseOrderLine_orderId_itemId_key" ON "PurchaseOrderLine"("orderId", "itemId");
CREATE INDEX "PurchaseOrderLine_organizationId_orderId_position_idx" ON "PurchaseOrderLine"("organizationId", "orderId", "position");
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_organizationId_orderId_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_organizationId_itemId_fkey" FOREIGN KEY ("organizationId", "itemId") REFERENCES "StockItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_orders_something" CHECK ("quantity" > 0 AND "unitPriceCents" >= 0);

-- Each email of an order to its vendor, written down before it is sent: the
-- same press never sends twice, and the day's count is read from here.
CREATE TABLE "PurchaseOrderDelivery" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "recipient" TEXT NOT NULL,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "failure" TEXT,
    "clientRequestId" TEXT NOT NULL,
    "sentById" UUID,
    "sentByName" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrderDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PurchaseOrderDelivery_organizationId_clientRequestId_key" ON "PurchaseOrderDelivery"("organizationId", "clientRequestId");
CREATE INDEX "PurchaseOrderDelivery_organizationId_createdAt_idx" ON "PurchaseOrderDelivery"("organizationId", "createdAt");
CREATE INDEX "PurchaseOrderDelivery_organizationId_orderId_idx" ON "PurchaseOrderDelivery"("organizationId", "orderId");
ALTER TABLE "PurchaseOrderDelivery" ADD CONSTRAINT "PurchaseOrderDelivery_organizationId_orderId_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderDelivery" ADD CONSTRAINT "PurchaseOrderDelivery_status_known" CHECK ("status" IN ('PENDING', 'SENT', 'FAILED'));

ALTER TABLE "PurchaseOrder" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PurchaseOrder"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "PurchaseOrderLine" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PurchaseOrderLine"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "PurchaseOrderDelivery" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PurchaseOrderDelivery"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
