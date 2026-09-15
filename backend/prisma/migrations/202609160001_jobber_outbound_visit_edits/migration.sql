-- Edits made in the console to a visit Jobber already has are pushed to Jobber:
-- a new day, a new technician, new Details, or a cancellation.
--
-- Four outbox kinds rather than one with a payload. Identity is (organization,
-- inspection, kind), so each edit coalesces with the next of its own kind, and
-- the worker reads the inspection when it sends -- the latest edit is the one
-- Jobber gets.
--
-- The enum values are added and NOT used here. Postgres will not let a value
-- added by ALTER TYPE be used in the same transaction, and Prisma runs a
-- migration in one.

-- AlterEnum
ALTER TYPE "JobberOutboundKind" ADD VALUE 'VISIT_RESCHEDULE';
ALTER TYPE "JobberOutboundKind" ADD VALUE 'VISIT_ASSIGN';
ALTER TYPE "JobberOutboundKind" ADD VALUE 'VISIT_EDIT';
ALTER TYPE "JobberOutboundKind" ADD VALUE 'VISIT_CANCEL';
