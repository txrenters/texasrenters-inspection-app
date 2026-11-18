-- Inventory (2026-11-19, phase 1 of the inventory and purchasing plan): what
-- the office stocks, where it is kept, who it is bought from, and the stock
-- ledger. On hand is never typed: every change to stock is one StockMovement,
-- written once, and StockLevel is those movements added up by the database
-- itself. Nothing here is called from anything billed.

CREATE TYPE "StockPlaceKind" AS ENUM ('STOCKROOM', 'VAN');
CREATE TYPE "StockMovementKind" AS ENUM ('OPENING_BALANCE', 'REVERSAL');

CREATE TABLE "Vendor" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "terms" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Vendor_organizationId_nameKey_key" ON "Vendor"("organizationId", "nameKey");
CREATE UNIQUE INDEX "Vendor_organizationId_id_key" ON "Vendor"("organizationId", "id");
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StockPlace" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "kind" "StockPlaceKind" NOT NULL DEFAULT 'STOCKROOM',
    "technicianId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockPlace_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockPlace_organizationId_nameKey_key" ON "StockPlace"("organizationId", "nameKey");
CREATE UNIQUE INDEX "StockPlace_organizationId_id_key" ON "StockPlace"("organizationId", "id");
ALTER TABLE "StockPlace" ADD CONSTRAINT "StockPlace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockPlace" ADD CONSTRAINT "StockPlace_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Only a van has a technician.
ALTER TABLE "StockPlace" ADD CONSTRAINT "StockPlace_technician_only_on_a_van" CHECK ("technicianId" IS NULL OR "kind" = 'VAN');

CREATE TABLE "StockItem" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "codeKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'each',
    "category" TEXT,
    "xeroTenantId" TEXT,
    "reorderLevel" INTEGER NOT NULL DEFAULT 0,
    "reorderQuantity" INTEGER NOT NULL DEFAULT 0,
    "usualVendorId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockItem_organizationId_codeKey_key" ON "StockItem"("organizationId", "codeKey");
CREATE UNIQUE INDEX "StockItem_organizationId_id_key" ON "StockItem"("organizationId", "id");
CREATE INDEX "StockItem_organizationId_active_idx" ON "StockItem"("organizationId", "active");
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A company of its own office, and a vendor of its own office.
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_organizationId_xeroTenantId_fkey" FOREIGN KEY ("organizationId", "xeroTenantId") REFERENCES "XeroOrganisation"("organizationId", "xeroTenantId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_organizationId_usualVendorId_fkey" FOREIGN KEY ("organizationId", "usualVendorId") REFERENCES "Vendor"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_reorder_not_negative" CHECK ("reorderLevel" >= 0 AND "reorderQuantity" >= 0);

CREATE TABLE "StockMovement" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "placeId" UUID NOT NULL,
    "kind" "StockMovementKind" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCostCents" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "note" TEXT,
    "reversesId" UUID,
    "requestKey" TEXT,
    "createdById" UUID,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);
-- A movement is reversed at most once, and one entry is written at most once.
CREATE UNIQUE INDEX "StockMovement_reversesId_key" ON "StockMovement"("reversesId");
CREATE UNIQUE INDEX "StockMovement_organizationId_requestKey_key" ON "StockMovement"("organizationId", "requestKey");
CREATE INDEX "StockMovement_organizationId_itemId_createdAt_idx" ON "StockMovement"("organizationId", "itemId", "createdAt");
-- RESTRICT throughout: nothing that has moved stock is ever removed from under its ledger.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_organizationId_itemId_fkey" FOREIGN KEY ("organizationId", "itemId") REFERENCES "StockItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_organizationId_placeId_fkey" FOREIGN KEY ("organizationId", "placeId") REFERENCES "StockPlace"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "StockMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_moves_something" CHECK ("quantity" <> 0);
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_cost_not_negative" CHECK ("unitCostCents" >= 0);
-- An opening balance brings stock in; a reversal names what it reverses, and nothing else does.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_opening_balance_is_in" CHECK ("kind" <> 'OPENING_BALANCE' OR "quantity" > 0);
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_reversal_names_its_movement" CHECK (("kind" = 'REVERSAL') = ("reversesId" IS NOT NULL));

CREATE TABLE "StockLevel" (
    "organizationId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "placeId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "valueCents" INTEGER NOT NULL,

    CONSTRAINT "StockLevel_pkey" PRIMARY KEY ("itemId", "placeId")
);
CREATE INDEX "StockLevel_organizationId_idx" ON "StockLevel"("organizationId");
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_organizationId_itemId_fkey" FOREIGN KEY ("organizationId", "itemId") REFERENCES "StockItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_organizationId_placeId_fkey" FOREIGN KEY ("organizationId", "placeId") REFERENCES "StockPlace"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Nobody takes out what is not there: a movement that would is refused whole.
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_never_below_nothing" CHECK ("quantity" >= 0);

-- The ledger is written once. A row is never changed and never removed; a
-- mistake is put right by a reversal.
CREATE FUNCTION "StockMovement_refuse_change"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'A stock movement is never changed or removed. Reverse it instead.'
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StockMovement_written_once"
    BEFORE UPDATE OR DELETE ON "StockMovement"
    FOR EACH ROW EXECUTE FUNCTION "StockMovement_refuse_change"();

-- On hand, and what it cost, kept by the database as each movement is written:
-- the application never writes StockLevel, so the two cannot drift apart. The
-- level's row is made empty first and then added to, because a CHECK is tested
-- on the row an INSERT proposes before ON CONFLICT is looked at: a movement
-- out, inserted as its own negative quantity, would be refused every time.
CREATE FUNCTION "StockMovement_add_to_level"() RETURNS trigger AS $$
BEGIN
    INSERT INTO "StockLevel" ("organizationId", "itemId", "placeId", "quantity", "valueCents")
    VALUES (NEW."organizationId", NEW."itemId", NEW."placeId", 0, 0)
    ON CONFLICT ("itemId", "placeId") DO NOTHING;
    UPDATE "StockLevel"
        SET "quantity" = "quantity" + NEW."quantity",
            "valueCents" = "valueCents" + NEW."quantity" * NEW."unitCostCents"
        WHERE "itemId" = NEW."itemId" AND "placeId" = NEW."placeId";
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StockMovement_keeps_level"
    AFTER INSERT ON "StockMovement"
    FOR EACH ROW EXECUTE FUNCTION "StockMovement_add_to_level"();

ALTER TABLE "Vendor" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Vendor"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "StockPlace" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "StockPlace"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "StockItem" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "StockItem"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "StockMovement" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "StockMovement"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "StockLevel" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "StockLevel"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
