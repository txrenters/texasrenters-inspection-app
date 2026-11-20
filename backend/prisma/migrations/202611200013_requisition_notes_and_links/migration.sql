-- Notes, comments and links on a purchase requisition (2026-11-20): the
-- ribbon's "Show Attached" group on the NAV-style requisition the office
-- approved on the canvas.
--
-- A note is something written on the record (who, when); a comment is one
-- message in its thread; both are one table told apart by `kind`. A link is a
-- web address with a title. Additive only: two new tables.

CREATE TABLE "PurchaseRequisitionNote" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "requisitionId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "writtenById" UUID NOT NULL,
    "writtenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseRequisitionNote_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseRequisitionNote_kind" CHECK ("kind" IN ('NOTE', 'COMMENT')),
    CONSTRAINT "PurchaseRequisitionNote_text_length" CHECK (length("text") BETWEEN 1 AND 2000)
);

CREATE INDEX "PurchaseRequisitionNote_organizationId_requisitionId_writtenAt_idx" ON "PurchaseRequisitionNote"("organizationId", "requisitionId", "writtenAt");
ALTER TABLE "PurchaseRequisitionNote" ADD CONSTRAINT "PurchaseRequisitionNote_requisition_fkey"
    FOREIGN KEY ("organizationId", "requisitionId") REFERENCES "PurchaseRequisition"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequisitionNote" ADD CONSTRAINT "PurchaseRequisitionNote_writtenById_fkey"
    FOREIGN KEY ("writtenById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PurchaseRequisitionLink" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "requisitionId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "addedById" UUID NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseRequisitionLink_pkey" PRIMARY KEY ("id"),
    -- Only a web address: never a javascript: or data: link that would run when opened.
    CONSTRAINT "PurchaseRequisitionLink_url" CHECK ("url" ~ '^https?://' AND length("url") <= 2000),
    CONSTRAINT "PurchaseRequisitionLink_title_length" CHECK (length("title") BETWEEN 1 AND 120)
);

CREATE INDEX "PurchaseRequisitionLink_organizationId_requisitionId_addedAt_idx" ON "PurchaseRequisitionLink"("organizationId", "requisitionId", "addedAt");
ALTER TABLE "PurchaseRequisitionLink" ADD CONSTRAINT "PurchaseRequisitionLink_requisition_fkey"
    FOREIGN KEY ("organizationId", "requisitionId") REFERENCES "PurchaseRequisition"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequisitionLink" ADD CONSTRAINT "PurchaseRequisitionLink_addedById_fkey"
    FOREIGN KEY ("addedById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseRequisitionNote" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PurchaseRequisitionNote"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "PurchaseRequisitionLink" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PurchaseRequisitionLink"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
