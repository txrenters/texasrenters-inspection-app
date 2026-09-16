-- A coordinator's edits to a draft visit, kept through a rebuild (the office, 2026-09-16).
--
-- The office edits a draft's visits in place -- the day, the technician, the
-- unit, the title, the Details, the visit length. The day and technician
-- already have their `*OverriddenAt`; these say the rest were set by a person,
-- so regeneration, the office's sheet and routing leave them as set. The unit
-- is the one only a person can give: the tenant and lease reports hold the
-- building, not which of its units a tenancy is in.

-- AlterTable
ALTER TABLE "TbpQuarterPlanStop" ADD COLUMN     "onSiteMinutesOverriddenAt" TIMESTAMP(3),
ADD COLUMN     "unitOverriddenAt" TIMESTAMP(3),
ADD COLUMN     "visitDetailsOverriddenAt" TIMESTAMP(3),
ADD COLUMN     "visitTitleOverriddenAt" TIMESTAMP(3);
