-- What a share link publishes (the office, 2026-10-06: the move-in / move-out
-- comparison goes to owners and tenants by link, as the inspection report does).
--
-- A comparison link is the same shape of thing as an inspection link: a link to
-- one inspection's material, issued by one person, expiring and revoked
-- identically. Only the document differs, so this adds a discriminator rather
-- than a second table -- token resolution, expiry and revocation stay in one
-- place, and so does the one photo route that serves both.
--
-- Additive and defaulted. `prisma migrate deploy` is forward-only and the
-- database is never rolled back, so every link issued before this keeps serving
-- the inspection report it was created for, and the previous image reads the
-- column it does not know about as absent.
CREATE TYPE "ReportShareKind" AS ENUM ('INSPECTION', 'COMPARISON');

ALTER TABLE "InspectionReportShare"
  ADD COLUMN "kind" "ReportShareKind" NOT NULL DEFAULT 'INSPECTION';
