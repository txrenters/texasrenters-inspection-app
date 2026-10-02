-- The template group a planned day was laid out from, kept on the day: its
-- number, name and colour as they were when the day was built (the office,
-- 2026-10-03: "let's not modify the groupings label, it should stay the same
-- as is").
--
-- "templateGroupId" alone lost them. A template's save makes its groups
-- again, so the link is cut (ON DELETE SET NULL) and the numbers can change.
-- A quarter built from template Group 37 then showed that day as "1", its
-- place in date order.
--
-- Filled in here for the days whose link still stands -- their template has
-- not been saved since, so its numbers are the ones the day was built with. A
-- day whose link was already cut stays null until the quarter is rebuilt.
--
-- Additive only: nullable columns on an existing table, whose tenant policy
-- already covers them.

-- AlterTable
ALTER TABLE "TbpQuarterPlanDay"
  ADD COLUMN IF NOT EXISTS "templateGroupPosition" INTEGER,
  ADD COLUMN IF NOT EXISTS "templateGroupName" TEXT,
  ADD COLUMN IF NOT EXISTS "templateGroupColor" TEXT;

-- Backfill
UPDATE "TbpQuarterPlanDay" AS plan_day
SET
  "templateGroupPosition" = template_group."position",
  "templateGroupName" = template_group."name",
  "templateGroupColor" = template_group."color"
FROM "TbpGroupTemplateGroup" AS template_group
WHERE plan_day."templateGroupId" = template_group."id"
  AND plan_day."templateGroupPosition" IS NULL;
