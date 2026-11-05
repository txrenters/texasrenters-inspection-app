-- Jobber's job number on each inspection (2026-11-06: "the job numbers also is
-- missing on our inspection app and console"). The visit sync has always read
-- it with the visit and never kept it; from now on it does, on every pass.

ALTER TABLE "Inspection" ADD COLUMN "jobberJobNumber" TEXT;

-- Every inspection already linked to a Jobber job takes the number from the
-- latest copy of any of that job's visits the sync kept, so the second job of
-- a visit and a visit the console booked get theirs too. Nothing is asked of
-- Jobber; one the sync has not seen yet is filled on its next pass.
UPDATE "Inspection" AS i
   SET "jobberJobNumber" = numbers."jobNumber"
  FROM (
    SELECT DISTINCT ON ("organizationId", "jobberJobId")
           "organizationId",
           "jobberJobId",
           btrim("payload" -> 'job' ->> 'jobNumber') AS "jobNumber"
      FROM "JobberVisitImport"
     WHERE "jobberJobId" IS NOT NULL
       AND NULLIF(btrim("payload" -> 'job' ->> 'jobNumber'), '') IS NOT NULL
     ORDER BY "organizationId", "jobberJobId", "updatedAt" DESC
  ) AS numbers
 WHERE i."organizationId" = numbers."organizationId"
   AND i."jobberJobId" = numbers."jobberJobId";
