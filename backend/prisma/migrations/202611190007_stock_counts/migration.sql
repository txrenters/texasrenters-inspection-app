-- Inventory counts (2026-11-19, phase 6 of the inventory and purchasing
-- plan): monthly, quarterly and yearly. A count lists what is to be counted;
-- posting it writes one stock movement an item that differed, and the
-- ledger's own trigger keeps what is on hand. Nothing here is called from
-- anything billed.

-- A new value, added and not used as an enum in this migration: a new enum
-- value cannot be used in the transaction that adds it.
ALTER TYPE "StockMovementKind" ADD VALUE IF NOT EXISTS 'COUNT_ADJUSTMENT';

CREATE TYPE "StockCountKind" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');
CREATE TYPE "StockCountStatus" AS ENUM ('OPEN', 'COUNTING', 'REVIEW', 'POSTED', 'CANCELLED');
CREATE TYPE "StockCountReason" AS ENUM ('TAKEN_WITHOUT_WITHDRAWAL', 'RETURNED_WITHOUT_RETURN', 'DAMAGED', 'MISCOUNTED_BEFORE', 'NOT_KNOWN');

CREATE TABLE "StockCount" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "StockCountKind" NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'OPEN',
    "day" DATE NOT NULL,
    "placeId" UUID,
    "note" TEXT,
    "requestKey" TEXT NOT NULL,
    "startedById" UUID,
    "startedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "countedById" UUID,
    "countedByName" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "approvedByName" TEXT,
    "postedAt" TIMESTAMP(3),
    "netValueCents" INTEGER,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByName" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockCount_organizationId_number_key" ON "StockCount"("organizationId", "number");
-- One press starts one count.
CREATE UNIQUE INDEX "StockCount_organizationId_requestKey_key" ON "StockCount"("organizationId", "requestKey");
CREATE UNIQUE INDEX "StockCount_organizationId_id_key" ON "StockCount"("organizationId", "id");
CREATE INDEX "StockCount_organizationId_createdAt_idx" ON "StockCount"("organizationId", "createdAt");
-- A place is in one unfinished count at a time, and an office has one unfinished yearly count.
CREATE UNIQUE INDEX "StockCount_one_open_a_place" ON "StockCount"("organizationId", "placeId") WHERE "status" IN ('OPEN', 'COUNTING', 'REVIEW') AND "placeId" IS NOT NULL;
CREATE UNIQUE INDEX "StockCount_one_open_yearly" ON "StockCount"("organizationId") WHERE "status" IN ('OPEN', 'COUNTING', 'REVIEW') AND "kind" = 'YEARLY';
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_organizationId_placeId_fkey" FOREIGN KEY ("organizationId", "placeId") REFERENCES "StockPlace"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A yearly count is everywhere; the others are of one place.
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_place_fits_its_kind" CHECK (("kind" = 'YEARLY') = ("placeId" IS NULL));
-- Posted by somebody, who is not the person who counted.
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_posted_by_somebody_else" CHECK (
    ("status" <> 'POSTED' AND "postedAt" IS NULL AND "approvedById" IS NULL)
    OR ("status" = 'POSTED' AND "postedAt" IS NOT NULL AND "approvedById" IS NOT NULL AND "approvedByName" IS NOT NULL
        AND "countedById" IS NOT NULL AND "approvedById" <> "countedById" AND "netValueCents" IS NOT NULL)
);
-- Reviewed only once it has been counted and handed in.
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_reviewed_after_counting" CHECK ("status" NOT IN ('REVIEW', 'POSTED') OR ("countedById" IS NOT NULL AND "submittedAt" IS NOT NULL));
-- Cancelled with who, when and why, or not cancelled.
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_cancelled_with_a_reason" CHECK (
    ("status" <> 'CANCELLED' AND "cancelledAt" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancelledByName" IS NOT NULL AND length(btrim(coalesce("cancelReason", ''))) > 0)
);

CREATE TABLE "StockCountLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "countId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "placeId" UUID NOT NULL,
    "countedQuantity" INTEGER,
    "firstCountedQuantity" INTEGER,
    "recount" BOOLEAN NOT NULL DEFAULT false,
    "expectedQuantity" INTEGER,
    "unitCostCents" INTEGER,
    "reason" "StockCountReason",
    "movementId" UUID,

    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);
-- An item is counted once a place in a count; a movement belongs to one line.
CREATE UNIQUE INDEX "StockCountLine_countId_itemId_placeId_key" ON "StockCountLine"("countId", "itemId", "placeId");
CREATE UNIQUE INDEX "StockCountLine_movementId_key" ON "StockCountLine"("movementId");
CREATE INDEX "StockCountLine_organizationId_itemId_idx" ON "StockCountLine"("organizationId", "itemId");
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_organizationId_countId_fkey" FOREIGN KEY ("organizationId", "countId") REFERENCES "StockCount"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_organizationId_itemId_fkey" FOREIGN KEY ("organizationId", "itemId") REFERENCES "StockItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_organizationId_placeId_fkey" FOREIGN KEY ("organizationId", "placeId") REFERENCES "StockPlace"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "StockMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_counts_are_not_negative" CHECK (
    ("countedQuantity" IS NULL OR "countedQuantity" >= 0) AND ("firstCountedQuantity" IS NULL OR "firstCountedQuantity" >= 0)
    AND ("expectedQuantity" IS NULL OR "expectedQuantity" >= 0) AND ("unitCostCents" IS NULL OR "unitCostCents" >= 0)
);
-- What was expected is written when the count is handed in, with what one costs, and not before.
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_expected_with_its_count" CHECK (
    ("expectedQuantity" IS NULL AND "unitCostCents" IS NULL)
    OR ("expectedQuantity" IS NOT NULL AND "unitCostCents" IS NOT NULL AND "countedQuantity" IS NOT NULL)
);
-- An adjustment is written only for a line that differed, with why.
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_adjusted_with_a_reason" CHECK (
    "movementId" IS NULL OR ("reason" IS NOT NULL AND "expectedQuantity" IS NOT NULL AND "countedQuantity" <> "expectedQuantity")
);

-- While a yearly count is open nothing moves: what is counted must still be
-- there when the count is posted. Only the count's own adjustments get in.
-- The services say so first, in the office's words; this holds when two
-- requests race. Compared as text: the value added above is not used here.
CREATE FUNCTION "StockMovement_stock_is_frozen"() RETURNS trigger AS $$
BEGIN
    IF NEW."kind"::text <> 'COUNT_ADJUSTMENT' AND EXISTS (
        SELECT 1 FROM "StockCount"
        WHERE "organizationId" = NEW."organizationId" AND "kind" = 'YEARLY' AND "status" IN ('OPEN', 'COUNTING', 'REVIEW')
    ) THEN
        RAISE EXCEPTION 'StockCount_stock_is_frozen: a yearly count is open, so stock cannot move.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "StockMovement_stock_is_frozen" BEFORE INSERT ON "StockMovement"
    FOR EACH ROW EXECUTE FUNCTION "StockMovement_stock_is_frozen"();

ALTER TABLE "StockCount" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "StockCount"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "StockCountLine" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "StockCountLine"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
