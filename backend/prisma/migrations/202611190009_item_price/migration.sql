-- An item's usual price (2026-11-19): optional, and only what a purchase
-- request line starts its cost from. It is not what stock on hand is worth:
-- that stays the ledger's. Additive only.
ALTER TABLE "StockItem" ADD COLUMN "priceCents" INTEGER;
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_price_not_negative" CHECK ("priceCents" IS NULL OR "priceCents" >= 0);
