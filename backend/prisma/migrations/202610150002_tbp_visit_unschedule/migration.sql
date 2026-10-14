-- A published benefit-package visit taken off its day in the console goes to
-- Jobber's Unscheduled list on the same job (the office, 2026-10-15: "if we
-- unschedule it from console it should be unscheduled on jobber to same way").
--
-- Its inspection is deleted here at once; this task then gives the job a visit
-- with no day and removes the dated one. The plan stop keeps the job, and
-- publishing it again gives that same visit its new day.

-- AlterEnum
ALTER TYPE "JobberOutboundKind" ADD VALUE IF NOT EXISTS 'TBP_VISIT_UNSCHEDULE';
