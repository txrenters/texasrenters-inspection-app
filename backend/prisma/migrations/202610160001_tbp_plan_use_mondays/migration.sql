-- A plan may visit on Mondays too, rather than keep each Monday from its
-- second week free for rescheduled visits (the office, 2026-10-15: "an option
-- too to use all mondays if we wanted"). Kept on the plan, as its crew is, so
-- a rebuild keeps the answer. Every plan before it kept its Mondays.

-- AlterTable
ALTER TABLE "TbpQuarterPlan" ADD COLUMN IF NOT EXISTS "useMondays" BOOLEAN NOT NULL DEFAULT false;
