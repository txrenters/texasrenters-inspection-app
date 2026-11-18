-- Item codes by category (2026-11-19). The office: the stock keeper creates
-- the items, the console numbers their codes, and every line of a purchase
-- requisition uses one. A category has a prefix and the next number; an
-- item's code is "<prefix>-<number>". Nothing here is called from anything
-- billed.

CREATE TABLE "StockCategory" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockCategory_organizationId_nameKey_key" ON "StockCategory"("organizationId", "nameKey");
CREATE UNIQUE INDEX "StockCategory_organizationId_prefix_key" ON "StockCategory"("organizationId", "prefix");
CREATE UNIQUE INDEX "StockCategory_organizationId_id_key" ON "StockCategory"("organizationId", "id");
ALTER TABLE "StockCategory" ADD CONSTRAINT "StockCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A letter, then one to five letters or digits, upper case: what a code can start with.
ALTER TABLE "StockCategory" ADD CONSTRAINT "StockCategory_prefix_shape" CHECK ("prefix" ~ '^[A-Z][A-Z0-9]{1,5}$');
ALTER TABLE "StockCategory" ADD CONSTRAINT "StockCategory_next_is_a_number" CHECK ("nextNumber" >= 1);

ALTER TABLE "StockItem" ADD COLUMN "categoryId" UUID;

-- Items added while a category was only a word keep their category and their
-- code: each word becomes a category, with a prefix the office can change
-- (C01, C02 ...) because it has numbered nothing yet.
INSERT INTO "StockCategory" ("id", "organizationId", "name", "nameKey", "prefix", "updatedAt")
SELECT gen_random_uuid(),
       words."organizationId",
       words."name",
       words."nameKey",
       'C' || lpad((row_number() OVER (PARTITION BY words."organizationId" ORDER BY words."nameKey"))::text, 2, '0'),
       CURRENT_TIMESTAMP
  FROM (
        SELECT "organizationId", min(btrim("category")) AS "name", lower(btrim("category")) AS "nameKey"
          FROM "StockItem"
         WHERE btrim(coalesce("category", '')) <> ''
         GROUP BY "organizationId", lower(btrim("category"))
       ) AS words;

UPDATE "StockItem" AS item
   SET "categoryId" = category."id"
  FROM "StockCategory" AS category
 WHERE category."organizationId" = item."organizationId"
   AND category."nameKey" = lower(btrim(item."category"));

ALTER TABLE "StockItem" DROP COLUMN "category";
-- A category of its own office, and never removed from under its items.
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_organizationId_categoryId_fkey" FOREIGN KEY ("organizationId", "categoryId") REFERENCES "StockCategory"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every line of a requisition asks for an item by its code. NOT VALID: a line
-- written in words before this is left as it is, and no new one is accepted.
ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_asks_by_item_code" CHECK ("itemId" IS NOT NULL) NOT VALID;

ALTER TABLE "StockCategory" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "StockCategory"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
