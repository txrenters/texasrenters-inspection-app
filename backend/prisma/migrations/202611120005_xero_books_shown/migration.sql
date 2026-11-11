-- Each company's books shown as Xero has them (2026-11-12, PR 3 of the plan to
-- make invoices in the console with Xero as the record). A row read from Xero
-- names Jobber's copy of the same invoice, so the copy is not shown beside it.
-- Additive: one nullable column, its index and its check; then the rows
-- already read are given their copy, as the read itself now does.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "jobberCopyId" UUID;

-- CreateIndex
CREATE INDEX "Invoice_jobberCopyId_idx" ON "Invoice"("jobberCopyId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_jobberCopyId_fkey" FOREIGN KEY ("jobberCopyId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Only a row read from Xero stands for a Jobber copy.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_jobber_copy_on_xero_row" CHECK ("jobberCopyId" IS NULL OR "origin" = 'XERO');

-- The Jobber invoice the console sent as it.
UPDATE "Invoice" x
   SET "jobberCopyId" = s."invoiceId"
  FROM "XeroInvoiceSync" s
  JOIN "Invoice" j ON j."id" = s."invoiceId" AND j."origin" = 'JOBBER'
 WHERE x."origin" = 'XERO'
   AND x."jobberCopyId" IS NULL
   AND s."organizationId" = x."organizationId"
   AND s."xeroTenantId" = x."xeroTenantId"
   AND s."xeroInvoiceId" = x."xeroInvoiceId";

-- Else the only Jobber invoice under its number in the same company; or, with
-- none there, the only one of no company for the same client.
WITH candidates AS (
  SELECT x."id" AS "xeroId", j."id" AS "jobberId", j."xeroTenantId" IS NOT NULL AS "sameCompany"
    FROM "Invoice" x
    JOIN "Invoice" j
      ON j."organizationId" = x."organizationId"
     AND j."origin" = 'JOBBER'
     AND j."number" = x."number"
   WHERE x."origin" = 'XERO'
     AND x."jobberCopyId" IS NULL
     AND x."number" IS NOT NULL
     AND (
          j."xeroTenantId" = x."xeroTenantId"
       OR (j."xeroTenantId" IS NULL
           AND lower(regexp_replace(btrim(j."clientName"), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(x."clientName"), '\s+', ' ', 'g')))
     )
), chosen AS (
  SELECT "xeroId",
         CASE
           WHEN count(*) FILTER (WHERE "sameCompany") = 1 THEN (array_agg("jobberId") FILTER (WHERE "sameCompany"))[1]
           WHEN count(*) FILTER (WHERE "sameCompany") = 0 AND count(*) = 1 THEN (array_agg("jobberId"))[1]
         END AS "jobberId"
    FROM candidates
   GROUP BY "xeroId"
)
UPDATE "Invoice" x
   SET "jobberCopyId" = c."jobberId"
  FROM chosen c
 WHERE x."id" = c."xeroId"
   AND c."jobberId" IS NOT NULL;
