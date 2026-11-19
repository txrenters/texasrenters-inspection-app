-- Files on a purchase requisition (2026-11-20, part 3 of the NAV-style
-- requisition the office approved on the canvas): pictures, quotes and lists
-- attached to it. Each is kept in the console's private storage and opened by
-- a short-lived signed link; the row says what it is and who attached it.
-- One ticked "for the vendor" goes with the purchase order's email.
--
-- Additive only: a new table, nothing else changes.

CREATE TABLE "PurchaseRequisitionFile" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "requisitionId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "forVendor" BOOLEAN NOT NULL DEFAULT false,
    "attachedById" UUID NOT NULL,
    "attachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseRequisitionFile_pkey" PRIMARY KEY ("id"),
    -- 20 MB a file, as the office set it on the canvas.
    CONSTRAINT "PurchaseRequisitionFile_size" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 20000000),
    CONSTRAINT "PurchaseRequisitionFile_name_length" CHECK (length("fileName") BETWEEN 1 AND 200),
    -- What the console found the file to be by its first bytes, never what the browser called it.
    CONSTRAINT "PurchaseRequisitionFile_content_type" CHECK ("contentType" IN (
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/heic',
        'application/msword',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ))
);

CREATE UNIQUE INDEX "PurchaseRequisitionFile_storageKey_key" ON "PurchaseRequisitionFile"("storageKey");
CREATE INDEX "PurchaseRequisitionFile_organizationId_requisitionId_attachedAt_idx" ON "PurchaseRequisitionFile"("organizationId", "requisitionId", "attachedAt");

-- The requisition's own office only.
ALTER TABLE "PurchaseRequisitionFile" ADD CONSTRAINT "PurchaseRequisitionFile_requisition_fkey"
    FOREIGN KEY ("organizationId", "requisitionId") REFERENCES "PurchaseRequisition"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequisitionFile" ADD CONSTRAINT "PurchaseRequisitionFile_attachedById_fkey"
    FOREIGN KEY ("attachedById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseRequisitionFile" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PurchaseRequisitionFile"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
