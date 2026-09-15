-- The console can book an occupied inspection's visit in Jobber.
--
-- A new outbox kind rather than reusing TBP_VISIT_CREATE, which reads its
-- title, day and zone from a quarter plan stop. A console booking has no stop:
-- its title and Details are written onto the inspection when it is created, and
-- the job's title -- which carries no address -- rides on the task.
--
-- The enum value is added and NOT used here. Postgres will not let a value
-- added by ALTER TYPE be used in the same transaction, and Prisma runs a
-- migration in one.

-- AlterEnum
ALTER TYPE "JobberOutboundKind" ADD VALUE 'VISIT_CREATE';

-- AlterTable
ALTER TABLE "JobberOutboundTask" ADD COLUMN "jobTitle" TEXT;
