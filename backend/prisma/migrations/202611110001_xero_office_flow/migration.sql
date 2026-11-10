-- Xero the way the office keeps its books (2026-11-11). The console's own
-- connection takes over from Zapier: Jobber's invoices go to each company's
-- books from the console, as the office has been finishing them by hand --
-- dated on the visit's day, due at the end of that month, the property as the
-- reference, each line under its Xero item and tagged for the technician who
-- did the visit.

-- What the console last read of each organisation's tracking categories (with
-- their options) and products and services.
ALTER TABLE "XeroOrganisation" ADD COLUMN "trackingCategories" JSONB;
ALTER TABLE "XeroOrganisation" ADD COLUMN "items" JSONB;

-- The office's choices: whether payments go to Xero at all; the tracking
-- category lines are tagged in, and for each product or service the start of
-- its option ("HVAC Inspection Income") and its Xero item's code.
ALTER TABLE "XeroSettings" ADD COLUMN "paymentsToXero" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "XeroSettings" ADD COLUMN "trackingCategoryId" TEXT;
ALTER TABLE "XeroSettings" ADD COLUMN "trackingGroups" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "XeroSettings" ADD COLUMN "itemCodes" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "XeroSettings" ADD CONSTRAINT "XeroSettings_tracking_and_items_are_maps"
  CHECK (jsonb_typeof("trackingGroups") = 'object' AND jsonb_typeof("itemCodes") = 'object');

-- Jobber's invoices belong to the company their lines go to, as the console's
-- own do: the one company the products on them go to, none when they go to two
-- (or to none). Never one already in a company's books in Xero.
WITH wanted AS (
  SELECT i."id",
         CASE WHEN count(DISTINCT p."xeroTenantId") = 1 THEN min(p."xeroTenantId") END AS "xeroTenantId"
    FROM "Invoice" i
    LEFT JOIN "InvoiceLine" l ON l."invoiceId" = i."id"
    LEFT JOIN "InvoiceProduct" p
      ON p."organizationId" = i."organizationId"
     AND p."nameKey" = lower(btrim(l."name"))
     AND p."xeroTenantId" IS NOT NULL
   WHERE i."origin" = 'JOBBER'
     AND NOT EXISTS (SELECT 1 FROM "XeroInvoiceSync" s WHERE s."invoiceId" = i."id" AND s."xeroInvoiceId" IS NOT NULL)
   GROUP BY i."id"
)
UPDATE "Invoice" i
   SET "xeroTenantId" = wanted."xeroTenantId"
  FROM wanted
 WHERE i."id" = wanted."id"
   AND i."xeroTenantId" IS DISTINCT FROM wanted."xeroTenantId";
