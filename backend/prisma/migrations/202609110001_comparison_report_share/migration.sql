-- What a share link publishes.
--
-- A comparison report is the same shape of thing as an inspection report: a
-- link to one inspection's material, issued by one person, expiring and revoked
-- identically. Only the document differs, so this adds a discriminator rather
-- than a second table -- token resolution, expiry and revocation stay in one
-- place, and so does the photo route that serves both.
--
-- Additive and defaulted, deliberately. `prisma migrate deploy` is forward-only
-- and the database is never rolled back, so a release that starts using a new
-- shape must not require it: every link issued before this ran keeps serving the
-- inspection report it was created for, and a rollback to the previous image
-- reads the column it does not know about as absent rather than failing.
CREATE TYPE "ReportShareKind" AS ENUM ('INSPECTION', 'COMPARISON');

ALTER TABLE "InspectionReportShare"
  ADD COLUMN "kind" "ReportShareKind" NOT NULL DEFAULT 'INSPECTION';
