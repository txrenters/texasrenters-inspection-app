-- Withdrawals, returns and moves (2026-11-19, phase 5 of the inventory and
-- purchasing plan). A slip is the paper for stock leaving a place, coming
-- back, or going from one place to another; each of its lines is a stock
-- movement, and the ledger's own trigger keeps what is on hand. Nothing here
-- is called from anything billed.

-- New values, added and not used in this migration: a new enum value cannot
-- be used in the transaction that adds it.
ALTER TYPE "StockMovementKind" ADD VALUE IF NOT EXISTS 'WITHDRAWAL';
ALTER TYPE "StockMovementKind" ADD VALUE IF NOT EXISTS 'RETURN';
ALTER TYPE "StockMovementKind" ADD VALUE IF NOT EXISTS 'TRANSFER';

-- A withdrawal takes stock out and a return brings it in. Compared as text,
-- so the values added above are not used as enums here.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_withdrawal_is_out" CHECK ("kind"::text <> 'WITHDRAWAL' OR "quantity" < 0);
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_return_is_in" CHECK ("kind"::text <> 'RETURN' OR "quantity" > 0);

CREATE TYPE "StockSlipKind" AS ENUM ('WITHDRAWAL', 'RETURN', 'TRANSFER');

CREATE TABLE "StockSlip" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "StockSlipKind" NOT NULL,
    "day" DATE NOT NULL,
    "technicianId" UUID,
    "fromPlaceId" UUID,
    "toPlaceId" UUID,
    "inspectionId" UUID,
    "note" TEXT,
    "requestKey" TEXT NOT NULL,
    "createdById" UUID,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedById" UUID,
    "reversedByName" TEXT,
    "reverseReason" TEXT,

    CONSTRAINT "StockSlip_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockSlip_organizationId_number_key" ON "StockSlip"("organizationId", "number");
-- One press posts one slip.
CREATE UNIQUE INDEX "StockSlip_organizationId_requestKey_key" ON "StockSlip"("organizationId", "requestKey");
CREATE UNIQUE INDEX "StockSlip_organizationId_id_key" ON "StockSlip"("organizationId", "id");
CREATE INDEX "StockSlip_organizationId_createdAt_idx" ON "StockSlip"("organizationId", "createdAt");
CREATE INDEX "StockSlip_organizationId_technicianId_createdAt_idx" ON "StockSlip"("organizationId", "technicianId", "createdAt");
CREATE INDEX "StockSlip_inspectionId_idx" ON "StockSlip"("inspectionId");
ALTER TABLE "StockSlip" ADD CONSTRAINT "StockSlip_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Who took it stays on the slip: a person with stock to their name is not removed from under it.
ALTER TABLE "StockSlip" ADD CONSTRAINT "StockSlip_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockSlip" ADD CONSTRAINT "StockSlip_organizationId_fromPlaceId_fkey" FOREIGN KEY ("organizationId", "fromPlaceId") REFERENCES "StockPlace"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockSlip" ADD CONSTRAINT "StockSlip_organizationId_toPlaceId_fkey" FOREIGN KEY ("organizationId", "toPlaceId") REFERENCES "StockPlace"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A visit removed later leaves the slip, and what it took, where it was.
ALTER TABLE "StockSlip" ADD CONSTRAINT "StockSlip_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- A withdrawal leaves a place and somebody takes it; a return comes back to a
-- place and somebody brings it; a move goes between two different places.
ALTER TABLE "StockSlip" ADD CONSTRAINT "StockSlip_places_fit_its_kind" CHECK (
    ("kind" = 'WITHDRAWAL' AND "fromPlaceId" IS NOT NULL AND "toPlaceId" IS NULL AND "technicianId" IS NOT NULL)
    OR ("kind" = 'RETURN' AND "toPlaceId" IS NOT NULL AND "fromPlaceId" IS NULL AND "technicianId" IS NOT NULL)
    OR ("kind" = 'TRANSFER' AND "fromPlaceId" IS NOT NULL AND "toPlaceId" IS NOT NULL AND "fromPlaceId" <> "toPlaceId" AND "inspectionId" IS NULL)
);
-- Reversed with who, when and why, or not reversed at all.
ALTER TABLE "StockSlip" ADD CONSTRAINT "StockSlip_reversal_has_who_and_why" CHECK (
    ("reversedAt" IS NULL AND "reversedByName" IS NULL AND "reverseReason" IS NULL)
    OR ("reversedAt" IS NOT NULL AND "reversedByName" IS NOT NULL AND length(btrim(coalesce("reverseReason", ''))) > 0)
);

CREATE TABLE "StockSlipLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "slipId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCostCents" INTEGER NOT NULL,
    "movementId" UUID NOT NULL,
    "movementInId" UUID,

    CONSTRAINT "StockSlipLine_pkey" PRIMARY KEY ("id")
);
-- An item is on a slip once; a movement belongs to one line.
CREATE UNIQUE INDEX "StockSlipLine_slipId_itemId_key" ON "StockSlipLine"("slipId", "itemId");
CREATE UNIQUE INDEX "StockSlipLine_movementId_key" ON "StockSlipLine"("movementId");
CREATE UNIQUE INDEX "StockSlipLine_movementInId_key" ON "StockSlipLine"("movementInId");
CREATE INDEX "StockSlipLine_organizationId_itemId_idx" ON "StockSlipLine"("organizationId", "itemId");
ALTER TABLE "StockSlipLine" ADD CONSTRAINT "StockSlipLine_organizationId_slipId_fkey" FOREIGN KEY ("organizationId", "slipId") REFERENCES "StockSlip"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockSlipLine" ADD CONSTRAINT "StockSlipLine_organizationId_itemId_fkey" FOREIGN KEY ("organizationId", "itemId") REFERENCES "StockItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockSlipLine" ADD CONSTRAINT "StockSlipLine_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "StockMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockSlipLine" ADD CONSTRAINT "StockSlipLine_movementInId_fkey" FOREIGN KEY ("movementInId") REFERENCES "StockMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockSlipLine" ADD CONSTRAINT "StockSlipLine_moves_something" CHECK ("quantity" > 0 AND "unitCostCents" >= 0);

ALTER TABLE "StockSlip" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "StockSlip"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "StockSlipLine" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "StockSlipLine"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
