-- A quarter can be published into Jobber's Unassigned list, with nobody on the
-- visits, so the office hands them out in Jobber rather than here.
--
-- The plan still routes days per technician and the inspection still carries its
-- assignment -- that is what the phone reads, and what the console's own
-- calendar is built from. Only the `teamMemberIds` sent to Jobber are dropped,
-- which is what puts a visit in Jobber's Unassigned list.
--
-- Asked in the build dialog beside the crew and stored on the plan rather than
-- passed at publish time, because a visit reaches Jobber minutes to hours after
-- the plan is published (the outbound queue drains 25 per five-minute tick) and
-- this is a fact about the plan, not about the queue that carries it.
--
-- False for every existing plan, which is the behaviour they already had.

-- AlterTable
ALTER TABLE "TbpQuarterPlan"
  ADD COLUMN IF NOT EXISTS "jobberUnassigned" BOOLEAN NOT NULL DEFAULT false;
