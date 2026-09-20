-- A quarter publishes even while visits need attention, and those go to Jobber
-- with no day on them (the office, 2026-09-20: "let's not make the needs
-- attention as blocker for publishing the TBP ... those needs to an attention
-- should be reflected also into the unscheduled appointment").
--
-- A visit with no day is not an inspection yet -- an inspection is booked for a
-- day -- so its outbound task carries the plan stop instead, and the stop is
-- UNSCHEDULED until the office puts it on the calendar in Jobber.

-- AlterEnum
ALTER TYPE "JobberOutboundKind" ADD VALUE IF NOT EXISTS 'TBP_JOB_UNSCHEDULED';

-- AlterEnum
ALTER TYPE "TbpStopStatus" ADD VALUE IF NOT EXISTS 'UNSCHEDULED';

-- AlterTable
ALTER TABLE "JobberOutboundTask" ALTER COLUMN "inspectionId" DROP NOT NULL;
ALTER TABLE "JobberOutboundTask" ADD COLUMN IF NOT EXISTS "tbpStopId" UUID;

-- AddForeignKey
ALTER TABLE "JobberOutboundTask"
  ADD CONSTRAINT "JobberOutboundTask_tbpStopId_fkey"
  FOREIGN KEY ("tbpStopId") REFERENCES "TbpQuarterPlanStop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One unscheduled job per stop: publishing a plan again must not make a second
-- job in somebody's calendar.
CREATE UNIQUE INDEX IF NOT EXISTS "JobberOutboundTask_organizationId_tbpStopId_kind_key"
  ON "JobberOutboundTask"("organizationId", "tbpStopId", "kind");
