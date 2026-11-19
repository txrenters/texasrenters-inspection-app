-- Jobs (2026-11-20, phase 1 of the jobs plan): what the office books is a
-- job -- a number, a title, one property -- holding every inspection made in
-- that one booking. Each inspection keeps its own areas, report and review;
-- the job only groups them. Additive: every existing inspection keeps a null
-- job and reads as a job of one. Nothing here calls anything billed.

CREATE TYPE "JobSource" AS ENUM ('CONSOLE');

CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "propertywareBuildingId" UUID NOT NULL,
    "propertywareUnitId" UUID,
    "source" "JobSource" NOT NULL DEFAULT 'CONSOLE',
    "requestKey" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);
-- A number names one job in the company, whether the series gave it or the office typed it.
CREATE UNIQUE INDEX "Job_organizationId_number_key" ON "Job"("organizationId", "number");
-- One press of Save makes one job.
CREATE UNIQUE INDEX "Job_organizationId_requestKey_key" ON "Job"("organizationId", "requestKey");
CREATE UNIQUE INDEX "Job_organizationId_id_key" ON "Job"("organizationId", "id");
CREATE INDEX "Job_organizationId_createdAt_idx" ON "Job"("organizationId", "createdAt");
ALTER TABLE "Job" ADD CONSTRAINT "Job_number_is_set" CHECK (length(btrim("number")) BETWEEN 1 AND 40);
ALTER TABLE "Job" ADD CONSTRAINT "Job_title_is_set" CHECK (length(btrim("title")) BETWEEN 1 AND 160);
ALTER TABLE "Job" ADD CONSTRAINT "Job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_propertywareBuildingId_fkey" FOREIGN KEY ("propertywareBuildingId") REFERENCES "propertyware_buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_propertywareUnitId_fkey" FOREIGN KEY ("propertywareUnitId") REFERENCES "propertyware_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An inspection's job is in its own company: the key carries the company.
ALTER TABLE "Inspection" ADD COLUMN "jobId" UUID;
CREATE INDEX "Inspection_jobId_idx" ON "Inspection"("jobId");
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_organizationId_jobId_fkey" FOREIGN KEY ("organizationId", "jobId") REFERENCES "Job"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Each kind of inspection once in a job, while it is live. A cancelled one
-- leaves room to book that kind again; a work order is told apart by its own
-- key, so two repairs can share a job.
CREATE UNIQUE INDEX "Inspection_one_kind_a_job" ON "Inspection"("jobId", "inspectionType")
    WHERE "jobId" IS NOT NULL AND "source" <> 'WORK_ORDER' AND "status" <> 'CANCELLED';

-- Everything in a job is at the job's property. Checked only when a row has a
-- job, so every other write to Inspection pays nothing for it.
CREATE FUNCTION "Inspection_job_same_property"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Job"
     WHERE "Job"."id" = NEW."jobId"
       AND "Job"."organizationId" = NEW."organizationId"
       AND "Job"."propertywareBuildingId" IS NOT DISTINCT FROM NEW."propertywareBuildingId"
  ) THEN
    RAISE EXCEPTION 'An inspection in a job must be at the job''s property'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Inspection_job_same_property"
    BEFORE INSERT OR UPDATE OF "jobId", "propertywareBuildingId" ON "Inspection"
    FOR EACH ROW WHEN (NEW."jobId" IS NOT NULL)
    EXECUTE FUNCTION "Inspection_job_same_property"();

ALTER TABLE "Job" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Job"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
