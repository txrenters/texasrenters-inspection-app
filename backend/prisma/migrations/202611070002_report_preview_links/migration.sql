-- The link behind the job page's Open report button (2026-11-07, phase 2 of the
-- inspection page audit). The office had no way to read a job's report short of
-- creating a share link for it. Open report serves the same document through a
-- link that lasts an hour and is nobody's to send, so it is kept out of the
-- links listed for sharing. Additive.

ALTER TABLE "InspectionReportShare" ADD COLUMN "preview" BOOLEAN NOT NULL DEFAULT false;
