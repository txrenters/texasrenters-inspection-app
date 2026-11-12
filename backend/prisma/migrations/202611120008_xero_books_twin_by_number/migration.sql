-- Old invoices no longer listed twice (2026-11-12). A Jobber invoice of no
-- company stood beside the invoice read from Xero under its number whenever
-- Jobber named the client otherwise -- the tenant, where Xero has the property
-- or its owner: 1,751 THMP invoices of 2022 to January 2026. The read now
-- takes the number alone when it is the only Jobber invoice of no company
-- under it and the only invoice under it in any company's books in Xero, in a
-- company Jobber billed for; the rows already read are given their copy the
-- same way. Then a row read from
-- Xero on no visit or property takes its copy's, as the read does.
-- Data only: no column, index or check changes.

WITH lone_copies AS (
  SELECT j."organizationId", j."number", (array_agg(j."id"))[1] AS "jobberId"
    FROM "Invoice" j
   WHERE j."origin" = 'JOBBER'
     AND j."xeroTenantId" IS NULL
     AND j."number" IS NOT NULL
   GROUP BY j."organizationId", j."number"
  HAVING count(*) = 1
), lone_in_xero AS (
  SELECT x."organizationId", x."number", (array_agg(x."id"))[1] AS "xeroId"
    FROM "Invoice" x
   WHERE x."origin" = 'XERO'
     AND x."number" IS NOT NULL
   GROUP BY x."organizationId", x."number"
  HAVING count(*) = 1
)
UPDATE "Invoice" x
   SET "jobberCopyId" = c."jobberId"
  FROM lone_in_xero l
  JOIN lone_copies c ON c."organizationId" = l."organizationId" AND c."number" = l."number"
 WHERE x."id" = l."xeroId"
   AND x."jobberCopyId" IS NULL
   -- Never for a company Jobber never billed for (Crystal Creek Pest): its
   -- numbers meet Jobber's only by chance.
   AND EXISTS (
         SELECT 1 FROM "Invoice" b
          WHERE b."organizationId" = x."organizationId"
            AND b."origin" = 'JOBBER'
            AND b."xeroTenantId" = x."xeroTenantId")
   -- A Jobber invoice in the row's own company under the number is the read's to choose.
   AND NOT EXISTS (
         SELECT 1 FROM "Invoice" k
          WHERE k."organizationId" = x."organizationId"
            AND k."origin" = 'JOBBER'
            AND k."xeroTenantId" = x."xeroTenantId"
            AND k."number" = x."number")
   -- A copy stands for one invoice.
   AND NOT EXISTS (SELECT 1 FROM "Invoice" t WHERE t."jobberCopyId" = c."jobberId");

-- On no visit: the copy's visit, with its property. On a visit but no
-- property: the copy's property.
UPDATE "Invoice" x
   SET "inspectionId" = COALESCE(x."inspectionId", j."inspectionId"),
       "propertywareBuildingId" = CASE
         WHEN x."inspectionId" IS NULL AND j."inspectionId" IS NOT NULL THEN COALESCE(j."propertywareBuildingId", x."propertywareBuildingId")
         ELSE COALESCE(x."propertywareBuildingId", j."propertywareBuildingId")
       END
  FROM "Invoice" j
 WHERE j."id" = x."jobberCopyId"
   AND x."origin" = 'XERO'
   AND (   (x."inspectionId" IS NULL AND j."inspectionId" IS NOT NULL)
        OR (x."propertywareBuildingId" IS NULL AND j."propertywareBuildingId" IS NOT NULL));
