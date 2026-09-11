-- The outbox learns to create a visit, not only to complete one.
--
-- `jobberVisitId` becomes nullable because TBP_VISIT_CREATE is the first kind
-- that has no visit id when it is enqueued: it is creating the visit, so Jobber
-- supplies the id and the worker writes it back on success. Identity is
-- (organization, inspection, kind), so nothing depends on the column being
-- populated -- which is why the outbox can carry a create at all instead of
-- needing a second table.
--
-- Note the enum value is added and NOT used in this migration. Postgres will
-- not let a value added by ALTER TYPE be used in the same transaction, and
-- Prisma runs a migration in one.
--
-- Deliberately NOT touching `JobberVisitImport.jobberVisitId`, which is a
-- different column with the same name. It backs the sync's
-- @@unique([organizationId, jobberVisitId]) dedup, and making it nullable would
-- let the same visit import twice.

-- AlterEnum
ALTER TYPE "JobberOutboundKind" ADD VALUE 'TBP_VISIT_CREATE';

-- AlterTable
ALTER TABLE "JobberOutboundTask" ALTER COLUMN "jobberVisitId" DROP NOT NULL;

