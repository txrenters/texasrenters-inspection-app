-- One purchase order a vendor (2026-11-20, part 4 of the NAV-style
-- requisition): a requisition whose lines name three vendors becomes three
-- orders, as NAV makes them. Until now the database held a requisition to one
-- live order; it now holds it to one live order a vendor, and to one order
-- with no vendor yet (NULLS NOT DISTINCT), so a vendor's lines are never
-- ordered twice, even by two purchasers pressing at once.
--
-- No row changes: every requisition has at most one live order today, which
-- the new index allows.

DROP INDEX "PurchaseOrder_one_live_order_a_requisition";
CREATE UNIQUE INDEX "PurchaseOrder_one_live_order_a_vendor" ON "PurchaseOrder"("requisitionId", "vendorId") NULLS NOT DISTINCT WHERE "status" <> 'CANCELLED';
