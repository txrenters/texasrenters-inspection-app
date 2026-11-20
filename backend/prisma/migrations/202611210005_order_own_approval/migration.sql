-- An approver may approve an order they made (the office, 2026-11-21), as a
-- requisition they asked for. The service still refuses them sending it back.
ALTER TABLE "PurchaseOrder" DROP CONSTRAINT "PurchaseOrder_not_approved_by_its_maker";
