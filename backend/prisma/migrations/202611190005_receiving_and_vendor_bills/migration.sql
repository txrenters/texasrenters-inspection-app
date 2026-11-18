-- Receiving and the vendor's bill (2026-11-19, phase 4 of the inventory and
-- purchasing plan). A receipt against a purchase order is the only thing in
-- purchasing that puts stock on the shelf: it writes stock movements, and the
-- ledger's own trigger adds them to what is on hand. The vendor's bill is
-- matched to the order and its receipts, approved, and its payment written
-- down. Nothing here is called from anything billed.

-- New values, added and not used in this migration: a new enum value cannot
-- be used in the transaction that adds it.
ALTER TYPE "StockMovementKind" ADD VALUE IF NOT EXISTS 'RECEIPT';
ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'PARTLY_RECEIVED';
ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'RECEIVED';
ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'CLOSED';
ALTER TYPE "PurchaseRequisitionStatus" ADD VALUE IF NOT EXISTS 'CLOSED';

-- A receipt brings stock in, as an opening balance does. Compared as text, so
-- the value added above is not used as an enum here.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_receipt_is_in" CHECK ("kind"::text <> 'RECEIPT' OR "quantity" > 0);

-- How much of each line has arrived. Nobody receives more than was ordered,
-- whatever the application does.
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "receivedQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_received_within_ordered" CHECK ("receivedQuantity" >= 0 AND "receivedQuantity" <= "quantity");
-- What a receipt line and a bill line point at: a line of an order of their own office.
CREATE UNIQUE INDEX "PurchaseOrderLine_organizationId_id_key" ON "PurchaseOrderLine"("organizationId", "id");

-- The rest will not arrive: the order is finished with what has.
ALTER TABLE "PurchaseOrder" ADD COLUMN "shortClosedAt" TIMESTAMP(3);
ALTER TABLE "PurchaseOrder" ADD COLUMN "shortClosedById" UUID;
ALTER TABLE "PurchaseOrder" ADD COLUMN "shortCloseReason" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_shortClosedById_fkey" FOREIGN KEY ("shortClosedById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_short_close_has_who_and_why" CHECK (
    ("shortClosedAt" IS NULL AND "shortClosedById" IS NULL AND "shortCloseReason" IS NULL)
    OR ("shortClosedAt" IS NOT NULL AND "shortClosedById" IS NOT NULL AND length(btrim(coalesce("shortCloseReason", ''))) > 0)
);

CREATE TABLE "GoodsReceipt" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "orderId" UUID NOT NULL,
    "receivedOn" DATE NOT NULL,
    "packingSlip" TEXT,
    "note" TEXT,
    "requestKey" TEXT NOT NULL,
    "createdById" UUID,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedById" UUID,
    "reversedByName" TEXT,
    "reverseReason" TEXT,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GoodsReceipt_organizationId_number_key" ON "GoodsReceipt"("organizationId", "number");
-- One press posts one receipt.
CREATE UNIQUE INDEX "GoodsReceipt_organizationId_requestKey_key" ON "GoodsReceipt"("organizationId", "requestKey");
CREATE UNIQUE INDEX "GoodsReceipt_organizationId_id_key" ON "GoodsReceipt"("organizationId", "id");
CREATE INDEX "GoodsReceipt_organizationId_orderId_idx" ON "GoodsReceipt"("organizationId", "orderId");
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_organizationId_orderId_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Reversed with who, when and why, or not reversed at all.
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_reversal_has_who_and_why" CHECK (
    ("reversedAt" IS NULL AND "reversedByName" IS NULL AND "reverseReason" IS NULL)
    OR ("reversedAt" IS NOT NULL AND "reversedByName" IS NOT NULL AND length(btrim(coalesce("reverseReason", ''))) > 0)
);

CREATE TABLE "GoodsReceiptLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "receiptId" UUID NOT NULL,
    "orderLineId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "placeId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "movementId" UUID NOT NULL,

    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);
-- A receipt line is one stock movement, and a movement belongs to one line.
CREATE UNIQUE INDEX "GoodsReceiptLine_movementId_key" ON "GoodsReceiptLine"("movementId");
-- An order line is on a receipt once.
CREATE UNIQUE INDEX "GoodsReceiptLine_receiptId_orderLineId_key" ON "GoodsReceiptLine"("receiptId", "orderLineId");
CREATE INDEX "GoodsReceiptLine_organizationId_orderLineId_idx" ON "GoodsReceiptLine"("organizationId", "orderLineId");
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_organizationId_receiptId_fkey" FOREIGN KEY ("organizationId", "receiptId") REFERENCES "GoodsReceipt"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_organizationId_orderLineId_fkey" FOREIGN KEY ("organizationId", "orderLineId") REFERENCES "PurchaseOrderLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_organizationId_itemId_fkey" FOREIGN KEY ("organizationId", "itemId") REFERENCES "StockItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_organizationId_placeId_fkey" FOREIGN KEY ("organizationId", "placeId") REFERENCES "StockPlace"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "StockMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_receives_something" CHECK ("quantity" > 0);

CREATE TYPE "VendorBillStatus" AS ENUM ('HELD', 'MATCHED', 'APPROVED', 'PAID');

-- The vendor's invoice for an order: one an order.
CREATE TABLE "VendorBill" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "billNumber" TEXT NOT NULL,
    "billDate" DATE NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "status" "VendorBillStatus" NOT NULL DEFAULT 'HELD',
    "enteredById" UUID NOT NULL,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "overrideReason" TEXT,
    "paidOn" DATE,
    "paymentMethod" TEXT,
    "paymentReference" TEXT,
    "paidById" UUID,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorBill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VendorBill_orderId_key" ON "VendorBill"("orderId");
CREATE UNIQUE INDEX "VendorBill_organizationId_orderId_key" ON "VendorBill"("organizationId", "orderId");
CREATE UNIQUE INDEX "VendorBill_organizationId_id_key" ON "VendorBill"("organizationId", "id");
ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_organizationId_orderId_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_total_not_negative" CHECK ("totalCents" >= 0);
-- Approved, and so paid, means somebody approved it.
ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_approved_has_its_approver" CHECK (
    "status" NOT IN ('APPROVED', 'PAID') OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL)
);
-- A bill approved without matching is approved by somebody other than whoever entered it, with their reason.
ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_override_not_by_its_enterer" CHECK (
    "overrideReason" IS NULL OR ("approvedById" IS NOT NULL AND "approvedById" <> "enteredById" AND length(btrim("overrideReason")) > 0)
);
-- Paid means when, how and by whom, in one of the ways the office pays.
ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_paid_has_its_payment" CHECK (
    ("status" <> 'PAID' AND "paidOn" IS NULL AND "paymentMethod" IS NULL AND "paidById" IS NULL)
    OR ("status" = 'PAID' AND "paidOn" IS NOT NULL AND "paidById" IS NOT NULL AND "paidAt" IS NOT NULL AND "paymentMethod" IN ('CHECK', 'ACH', 'CARD', 'CASH', 'OTHER'))
);

CREATE TABLE "VendorBillLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "billId" UUID NOT NULL,
    "orderLineId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,

    CONSTRAINT "VendorBillLine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VendorBillLine_billId_orderLineId_key" ON "VendorBillLine"("billId", "orderLineId");
ALTER TABLE "VendorBillLine" ADD CONSTRAINT "VendorBillLine_organizationId_billId_fkey" FOREIGN KEY ("organizationId", "billId") REFERENCES "VendorBill"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorBillLine" ADD CONSTRAINT "VendorBillLine_organizationId_orderLineId_fkey" FOREIGN KEY ("organizationId", "orderLineId") REFERENCES "PurchaseOrderLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VendorBillLine" ADD CONSTRAINT "VendorBillLine_bills_something" CHECK ("quantity" > 0 AND "unitPriceCents" >= 0);

ALTER TABLE "GoodsReceipt" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "GoodsReceipt"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "GoodsReceiptLine" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "GoodsReceiptLine"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "VendorBill" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "VendorBill"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "VendorBillLine" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "VendorBillLine"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
