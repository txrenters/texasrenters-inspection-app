-- Each product keeps its own Xero choices (2026-11-13, PR 4 of the invoicing
-- audit). A product's account, item and tracking option in its company's books
-- were kept in that company's XeroSettings, keyed by the product's name: a
-- product renamed lost them, and its lines went to the default account without
-- a word. They are now kept on the product itself, so they go with it.
--
-- Additive: three nullable columns and a check, then the choices already made
-- copied onto each product from its own company's settings. The settings keep
-- their copy, untouched, for a release before this one to read.

-- AlterTable
ALTER TABLE "InvoiceProduct" ADD COLUMN "xeroAccountId" TEXT;
ALTER TABLE "InvoiceProduct" ADD COLUMN "xeroItemCode" TEXT;
ALTER TABLE "InvoiceProduct" ADD COLUMN "xeroTrackingGroup" TEXT;

-- A choice in a company's books needs the company.
ALTER TABLE "InvoiceProduct" ADD CONSTRAINT "InvoiceProduct_xero_choices_need_company"
  CHECK (("xeroAccountId" IS NULL AND "xeroItemCode" IS NULL AND "xeroTrackingGroup" IS NULL) OR "xeroTenantId" IS NOT NULL);

-- As chosen so far, for each product's own company, by its name.
UPDATE "InvoiceProduct" p
   SET "xeroAccountId"     = NULLIF(btrim(s."salesAccounts"  ->> p."nameKey"), ''),
       "xeroItemCode"      = NULLIF(btrim(s."itemCodes"      ->> p."nameKey"), ''),
       "xeroTrackingGroup" = NULLIF(btrim(s."trackingGroups" ->> p."nameKey"), '')
  FROM "XeroSettings" s
 WHERE s."organizationId" = p."organizationId"
   AND s."xeroTenantId" = p."xeroTenantId"
   AND (   s."salesAccounts"  ? p."nameKey"
        OR s."itemCodes"      ? p."nameKey"
        OR s."trackingGroups" ? p."nameKey");
