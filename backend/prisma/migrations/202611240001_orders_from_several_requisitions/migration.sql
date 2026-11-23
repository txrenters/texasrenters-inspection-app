-- One purchase order from several requisitions (the office, 2026-11-23): the
-- purchaser ticks approved requisition lines on Pending Processing, and each
-- vendor and company gets one order. The same item to the same place is one
-- line; each line keeps where it goes.

-- Each line of an order goes to its own place; until now, the order's.
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "placeId" UUID;
UPDATE "PurchaseOrderLine" l SET "placeId" = o."deliverToPlaceId" FROM "PurchaseOrder" o WHERE o."id" = l."orderId";
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_place_fkey"
    FOREIGN KEY ("organizationId", "placeId") REFERENCES "StockPlace"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX "PurchaseOrderLine_orderId_itemId_key";
CREATE UNIQUE INDEX "PurchaseOrderLine_orderId_itemId_placeId_key" ON "PurchaseOrderLine"("orderId", "itemId", "placeId") NULLS NOT DISTINCT;

-- Which requisition lines each order carries, and how many of each: kept at
-- the order and matched to its line by item and place.
CREATE TABLE "PurchaseOrderSource" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "requisitionId" UUID NOT NULL,
    "requisitionLineId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "placeId" UUID,
    "quantity" INTEGER NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseOrderSource_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseOrderSource_quantity" CHECK ("quantity" > 0)
);
ALTER TABLE "PurchaseOrderSource" ADD CONSTRAINT "PurchaseOrderSource_order_fkey"
    FOREIGN KEY ("organizationId", "orderId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderSource" ADD CONSTRAINT "PurchaseOrderSource_requisition_fkey"
    FOREIGN KEY ("organizationId", "requisitionId") REFERENCES "PurchaseRequisition"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A requisition's lines are written again when it is changed: only possible
-- while none is on a live order, so only released shares go with them.
ALTER TABLE "PurchaseOrderSource" ADD CONSTRAINT "PurchaseOrderSource_requisitionLine_fkey"
    FOREIGN KEY ("requisitionLineId") REFERENCES "PurchaseRequisitionLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "PurchaseOrderSource_organizationId_orderId_idx" ON "PurchaseOrderSource"("organizationId", "orderId");
CREATE INDEX "PurchaseOrderSource_organizationId_requisitionId_idx" ON "PurchaseOrderSource"("organizationId", "requisitionId");
-- A requisition line is on one live order at most, even with two purchasers pressing at once.
CREATE UNIQUE INDEX "PurchaseOrderSource_one_live_order_a_line" ON "PurchaseOrderSource"("requisitionLineId") WHERE "releasedAt" IS NULL;

-- Every order so far was made from one requisition: it carried that
-- requisition's lines of its items. A line on one live order at most: where
-- two live orders of the requisition have its item, the one to the line's own
-- vendor, else the older.
INSERT INTO "PurchaseOrderSource" ("id", "organizationId", "orderId", "requisitionId", "requisitionLineId", "itemId", "placeId", "quantity", "releasedAt", "createdAt")
SELECT DISTINCT ON (rl."id") gen_random_uuid(), o."organizationId", o."id", o."requisitionId", rl."id", rl."itemId", o."deliverToPlaceId", rl."quantity", NULL::TIMESTAMP(3), o."createdAt"
FROM "PurchaseOrder" o
JOIN "PurchaseOrderLine" l ON l."orderId" = o."id"
JOIN "PurchaseRequisitionLine" rl ON rl."requisitionId" = o."requisitionId" AND rl."itemId" = l."itemId"
WHERE o."status" <> 'CANCELLED' AND rl."quantity" > 0
ORDER BY rl."id", (o."vendorId" IS NOT DISTINCT FROM rl."vendorId") DESC, o."createdAt", o."id";

-- A cancelled order still shows what it carried, released.
INSERT INTO "PurchaseOrderSource" ("id", "organizationId", "orderId", "requisitionId", "requisitionLineId", "itemId", "placeId", "quantity", "releasedAt", "createdAt")
SELECT gen_random_uuid(), o."organizationId", o."id", o."requisitionId", rl."id", rl."itemId", o."deliverToPlaceId", rl."quantity", COALESCE(o."cancelledAt", o."createdAt"), o."createdAt"
FROM "PurchaseOrder" o
JOIN "PurchaseOrderLine" l ON l."orderId" = o."id"
JOIN "PurchaseRequisitionLine" rl ON rl."requisitionId" = o."requisitionId" AND rl."itemId" = l."itemId"
WHERE o."status" = 'CANCELLED' AND rl."quantity" > 0;

-- One live order a requisition and vendor no longer holds: a requisition's
-- lines for one vendor may be ordered on different days. Its lines hold it now.
DROP INDEX "PurchaseOrder_one_live_order_a_vendor";
