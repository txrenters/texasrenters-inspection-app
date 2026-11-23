-- The truck on the phone, round 2 (the office, 2026-11-24): what the office
-- keeps on each truck of an item, and the asks a technician sends from the
-- phone for more. The phone never moves stock: the office fills an ask with a
-- move from the Storeroom, which marks it filled.

CREATE TABLE "StockKeepLevel" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "placeId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "keepAtLeast" INTEGER NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StockKeepLevel_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockKeepLevel_keeps_some" CHECK ("keepAtLeast" > 0 AND "keepAtLeast" <= 10000)
);
CREATE UNIQUE INDEX "StockKeepLevel_placeId_itemId_key" ON "StockKeepLevel"("placeId", "itemId");
CREATE INDEX "StockKeepLevel_organizationId_placeId_idx" ON "StockKeepLevel"("organizationId", "placeId");
ALTER TABLE "StockKeepLevel" ADD CONSTRAINT "StockKeepLevel_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockKeepLevel" ADD CONSTRAINT "StockKeepLevel_organizationId_placeId_fkey"
    FOREIGN KEY ("organizationId", "placeId") REFERENCES "StockPlace"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockKeepLevel" ADD CONSTRAINT "StockKeepLevel_organizationId_itemId_fkey"
    FOREIGN KEY ("organizationId", "itemId") REFERENCES "StockItem"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "TruckStockAskStatus" AS ENUM ('ASKED', 'FILLED');

CREATE TABLE "TruckStockAsk" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "placeId" UUID NOT NULL,
    "askedById" UUID NOT NULL,
    "note" TEXT,
    "status" "TruckStockAskStatus" NOT NULL DEFAULT 'ASKED',
    "requestKey" TEXT NOT NULL,
    "filledSlipId" UUID,
    "filledById" UUID,
    "filledByName" TEXT,
    "filledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TruckStockAsk_pkey" PRIMARY KEY ("id"),
    -- Filled exactly when the move that filled it is named, with when.
    CONSTRAINT "TruckStockAsk_filled_by_a_move" CHECK (("status" = 'FILLED') = ("filledSlipId" IS NOT NULL AND "filledAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "TruckStockAsk_organizationId_requestKey_key" ON "TruckStockAsk"("organizationId", "requestKey");
CREATE UNIQUE INDEX "TruckStockAsk_organizationId_filledSlipId_key" ON "TruckStockAsk"("organizationId", "filledSlipId");
CREATE UNIQUE INDEX "TruckStockAsk_organizationId_id_key" ON "TruckStockAsk"("organizationId", "id");
CREATE INDEX "TruckStockAsk_organizationId_status_createdAt_idx" ON "TruckStockAsk"("organizationId", "status", "createdAt");
CREATE INDEX "TruckStockAsk_organizationId_placeId_status_idx" ON "TruckStockAsk"("organizationId", "placeId", "status");
ALTER TABLE "TruckStockAsk" ADD CONSTRAINT "TruckStockAsk_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TruckStockAsk" ADD CONSTRAINT "TruckStockAsk_organizationId_placeId_fkey"
    FOREIGN KEY ("organizationId", "placeId") REFERENCES "StockPlace"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TruckStockAsk" ADD CONSTRAINT "TruckStockAsk_askedById_fkey"
    FOREIGN KEY ("askedById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TruckStockAsk" ADD CONSTRAINT "TruckStockAsk_organizationId_filledSlipId_fkey"
    FOREIGN KEY ("organizationId", "filledSlipId") REFERENCES "StockSlip"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "TruckStockAskLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "askId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "itemId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    CONSTRAINT "TruckStockAskLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TruckStockAskLine_asks_some" CHECK ("quantity" > 0)
);
CREATE UNIQUE INDEX "TruckStockAskLine_askId_itemId_key" ON "TruckStockAskLine"("askId", "itemId");
CREATE INDEX "TruckStockAskLine_organizationId_askId_idx" ON "TruckStockAskLine"("organizationId", "askId");
ALTER TABLE "TruckStockAskLine" ADD CONSTRAINT "TruckStockAskLine_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TruckStockAskLine" ADD CONSTRAINT "TruckStockAskLine_organizationId_askId_fkey"
    FOREIGN KEY ("organizationId", "askId") REFERENCES "TruckStockAsk"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TruckStockAskLine" ADD CONSTRAINT "TruckStockAskLine_organizationId_itemId_fkey"
    FOREIGN KEY ("organizationId", "itemId") REFERENCES "StockItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
