-- Which of the office's template groups a planned day was laid out from
-- (2026-10-01), so the day can be shown in that group's name and colour, as
-- the Group maker shows it.
--
-- Null for a day the planner grouped itself -- every day of every existing
-- plan, and the days a template plan makes from properties in none of its
-- groups. A group deleted from its template leaves the day, without the name.
--
-- Additive only: a nullable column on an existing table, whose tenant policy
-- already covers it.

-- AlterTable
ALTER TABLE "TbpQuarterPlanDay"
  ADD COLUMN IF NOT EXISTS "templateGroupId" UUID;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TbpQuarterPlanDay_templateGroupId_idx" ON "TbpQuarterPlanDay"("templateGroupId");

-- AddForeignKey
ALTER TABLE "TbpQuarterPlanDay" ADD CONSTRAINT "TbpQuarterPlanDay_templateGroupId_fkey" FOREIGN KEY ("templateGroupId") REFERENCES "TbpGroupTemplateGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
