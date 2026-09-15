-- The Jobber visit's title and Details, kept on the inspection they describe.
--
-- The Details are where the office writes what a technician needs for a visit:
-- filter sizes, the tenant's phone, a gate code, the benefit plan. The sync read
-- them only to decide the visit's type and then discarded them.
ALTER TABLE "Inspection" ADD COLUMN "jobberVisitTitle" TEXT;
ALTER TABLE "Inspection" ADD COLUMN "jobberVisitDetails" TEXT;

-- Filled from the copy of every visit the sync already keeps, so nothing has to
-- ask Jobber again. When this was written 564 inspections came from Jobber and
-- the visits of 446 carried Details. Empty Details stay NULL.
UPDATE "Inspection" AS i
   SET "jobberVisitTitle" = v."payload"->>'title',
       "jobberVisitDetails" = CASE
         WHEN COALESCE(BTRIM(v."payload"->>'instructions'), '') = '' THEN NULL
         ELSE v."payload"->>'instructions'
       END
  FROM "JobberVisitImport" AS v
 WHERE i."jobberVisitId" IS NOT NULL
   AND v."organizationId" = i."organizationId"
   AND v."jobberVisitId" = i."jobberVisitId"
   AND v."payload" IS NOT NULL;
