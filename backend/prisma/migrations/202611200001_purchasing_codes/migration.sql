-- The codes a NAV-style purchase requisition picks from (2026-11-20, part 1
-- of the requisition the office approved on the canvas). Additive only.
--
-- 1. One table of short code lists the office makes: line types (what a line
--    is: an item that keeps stock, a service that does not), request codes
--    (the kind of request), department codes and cost center codes. A
--    department or cost center code can be matched, company by company, to a
--    tracking option in that company's Xero, so a bill reaches Xero coded.
-- 2. Every item code has a line type. Existing items are Items.
-- 3. Every place has a location code. Existing places get one made from their
--    name ("Office Storeroom" -> OFFICE-STOREROOM); the stock keeper can change it.
-- 4. Every vendor has a number, V-00001 and on, given by the console in the
--    order the vendors were added. The series carries on from the last one.
-- 5. A company (a connected Xero organisation) may have a purchaser code.

CREATE TYPE "PurchasingCodeKind" AS ENUM ('LINE_TYPE', 'REQUEST', 'DEPARTMENT', 'COST_CENTER');

CREATE TABLE "PurchasingCode" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "kind" "PurchasingCodeKind" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- Line types only: an item of this type is received into a place, counted and withdrawn.
    "keepsStock" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchasingCode_pkey" PRIMARY KEY ("id"),
    -- Kept in capitals by the console; the database holds the shape too.
    CONSTRAINT "PurchasingCode_code_shape" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
    CONSTRAINT "PurchasingCode_name_given" CHECK (length(btrim("name")) > 0)
);
CREATE UNIQUE INDEX "PurchasingCode_organizationId_kind_code_key" ON "PurchasingCode"("organizationId", "kind", "code");
CREATE UNIQUE INDEX "PurchasingCode_organizationId_id_key" ON "PurchasingCode"("organizationId", "id");
ALTER TABLE "PurchasingCode" ADD CONSTRAINT "PurchasingCode_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A department or cost center code, as the tracking option it is in one company's Xero.
CREATE TABLE "PurchasingCodeXeroOption" (
    "organizationId" UUID NOT NULL,
    "codeId" UUID NOT NULL,
    "xeroTenantId" TEXT NOT NULL,
    "trackingCategoryId" TEXT NOT NULL,
    "trackingOptionId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchasingCodeXeroOption_pkey" PRIMARY KEY ("codeId", "xeroTenantId")
);
CREATE INDEX "PurchasingCodeXeroOption_organizationId_xeroTenantId_idx" ON "PurchasingCodeXeroOption"("organizationId", "xeroTenantId");
ALTER TABLE "PurchasingCodeXeroOption" ADD CONSTRAINT "PurchasingCodeXeroOption_code_fkey"
    FOREIGN KEY ("organizationId", "codeId") REFERENCES "PurchasingCode"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchasingCodeXeroOption" ADD CONSTRAINT "PurchasingCodeXeroOption_company_fkey"
    FOREIGN KEY ("organizationId", "xeroTenantId") REFERENCES "XeroOrganisation"("organizationId", "xeroTenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every office starts with the two line types the office named: Item and Service.
INSERT INTO "PurchasingCode" ("organizationId", "kind", "code", "name", "keepsStock")
SELECT o."id", 'LINE_TYPE', t.code, t.name, t.keeps
FROM "Organization" o
CROSS JOIN (VALUES ('ITEM', 'Item', true), ('SERVICE', 'Service', false)) AS t(code, name, keeps);

-- 2. Each item's line type.
ALTER TABLE "StockItem" ADD COLUMN "lineTypeId" UUID;
UPDATE "StockItem" i SET "lineTypeId" = c."id"
FROM "PurchasingCode" c
WHERE c."organizationId" = i."organizationId" AND c."kind" = 'LINE_TYPE' AND c."code" = 'ITEM';
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_lineType_fkey"
    FOREIGN KEY ("organizationId", "lineTypeId") REFERENCES "PurchasingCode"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "StockItem_lineTypeId_idx" ON "StockItem"("lineTypeId");

-- 3. Location codes, made from each place's name, numbered where two would match.
ALTER TABLE "StockPlace" ADD COLUMN "code" TEXT;
WITH stems AS (
    SELECT "id", "organizationId", "createdAt",
           left(coalesce(nullif(btrim(regexp_replace(upper("name"), '[^A-Z0-9]+', '-', 'g'), '-'), ''), 'PLACE'), 16) AS stem
    FROM "StockPlace"
), numbered AS (
    SELECT "id", stem, row_number() OVER (PARTITION BY "organizationId", stem ORDER BY "createdAt", "id") AS n
    FROM stems
)
UPDATE "StockPlace" p
SET "code" = CASE WHEN numbered.n = 1 THEN numbered.stem ELSE numbered.stem || '-' || numbered.n END
FROM numbered
WHERE numbered."id" = p."id";
ALTER TABLE "StockPlace" ALTER COLUMN "code" SET NOT NULL;
ALTER TABLE "StockPlace" ADD CONSTRAINT "StockPlace_code_shape" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{0,19}$');
CREATE UNIQUE INDEX "StockPlace_organizationId_code_key" ON "StockPlace"("organizationId", "code");

-- 4. Vendor numbers, in the order the vendors were added, and the series after them.
ALTER TABLE "Vendor" ADD COLUMN "number" TEXT;
UPDATE "Vendor" v
SET "number" = 'V-' || lpad(n.rn::text, 5, '0')
FROM (SELECT "id", row_number() OVER (PARTITION BY "organizationId" ORDER BY "createdAt", "id") AS rn FROM "Vendor") n
WHERE n."id" = v."id";
ALTER TABLE "Vendor" ALTER COLUMN "number" SET NOT NULL;
CREATE UNIQUE INDEX "Vendor_organizationId_number_key" ON "Vendor"("organizationId", "number");
INSERT INTO "DocumentSeries" ("organizationId", "kind", "next")
SELECT "organizationId", 'V', count(*) + 1 FROM "Vendor" GROUP BY "organizationId"
ON CONFLICT ("organizationId", "kind") DO UPDATE SET "next" = GREATEST("DocumentSeries"."next", EXCLUDED."next");

-- 5. A company's purchaser code: optional, and never the same as another of the office's.
ALTER TABLE "XeroOrganisation" ADD COLUMN "purchaserCode" TEXT;
ALTER TABLE "XeroOrganisation" ADD CONSTRAINT "XeroOrganisation_purchaserCode_shape" CHECK ("purchaserCode" IS NULL OR "purchaserCode" ~ '^[A-Z0-9][A-Z0-9-]{0,19}$');
CREATE UNIQUE INDEX "XeroOrganisation_organizationId_purchaserCode_key" ON "XeroOrganisation"("organizationId", "purchaserCode");

-- Each office sees only its own, as on every other table.
ALTER TABLE "PurchasingCode" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PurchasingCode"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
ALTER TABLE "PurchasingCodeXeroOption" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PurchasingCodeXeroOption"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
