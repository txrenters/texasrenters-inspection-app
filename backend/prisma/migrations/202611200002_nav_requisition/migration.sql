-- The NAV-style purchase requisition (2026-11-20, part 2 of the requisition
-- the office approved on the canvas). Additive only: every column is new and
-- may be empty, so a requisition made before reads as it did.
--
-- General: a request code (the kind of request), a cost center code and a
-- document date (the day on the paper; the requisition date is when it was
-- made). Lines: the location it goes to, the day it is expected, the vendor,
-- a department code and a note. A line's description already exists: it now
-- holds the description the line was given, which starts as the item's.

ALTER TABLE "PurchaseRequisition"
    ADD COLUMN "requestCodeId" UUID,
    ADD COLUMN "costCenterId" UUID,
    ADD COLUMN "documentDate" DATE;
-- A requisition made before this has its document date on the day it was made.
UPDATE "PurchaseRequisition" SET "documentDate" = ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')::date WHERE "documentDate" IS NULL;

ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_requestCode_fkey"
    FOREIGN KEY ("organizationId", "requestCodeId") REFERENCES "PurchasingCode"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_costCenter_fkey"
    FOREIGN KEY ("organizationId", "costCenterId") REFERENCES "PurchasingCode"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseRequisitionLine"
    ADD COLUMN "placeId" UUID,
    ADD COLUMN "expectedOn" DATE,
    ADD COLUMN "vendorId" UUID,
    ADD COLUMN "departmentId" UUID,
    ADD COLUMN "notes" TEXT;

ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_place_fkey"
    FOREIGN KEY ("organizationId", "placeId") REFERENCES "StockPlace"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_vendor_fkey"
    FOREIGN KEY ("organizationId", "vendorId") REFERENCES "Vendor"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_department_fkey"
    FOREIGN KEY ("organizationId", "departmentId") REFERENCES "PurchasingCode"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_notes_length" CHECK ("notes" IS NULL OR length("notes") <= 1000);

CREATE INDEX "PurchaseRequisitionLine_vendorId_idx" ON "PurchaseRequisitionLine"("vendorId");
