-- Each benefit-package visit keeps its month of the quarter (the office, 2026-09-18).
--
-- "If on q3 this property is scheduled ... the first month on q3 then on q4 it
-- should be scheduled on the first month also." The day of each tenancy's visit
-- last quarter is kept on its stop, from the plan published then or, before any
-- was, from the visit Jobber ran. Null for a tenancy with no visit to go by.

-- AlterTable
ALTER TABLE "TbpQuarterPlanStop" ADD COLUMN     "previousVisitOn" DATE;
