-- The tenant report can say which unit a tenancy is in (the office, 2026-09-18).
--
-- In a building of several units the report writes only the building's address,
-- so the planner cannot tell which door a tenancy is behind. The office adds the
-- unit to the report: Propertyware's own unit id, or the unit as the office names
-- it. Both are kept as written, and a unit found this way is REPORT_UNIT.
--
-- REPORT_UNIT is added and not used here: Postgres will not let a value added by
-- ALTER TYPE be used in the same transaction, and Prisma runs a migration in one.

-- AlterEnum
ALTER TYPE "TbpUnitResolution" ADD VALUE 'REPORT_UNIT';

-- AlterTable
ALTER TABLE "PropertywareTenant" ADD COLUMN     "unitExternalId" TEXT,
ADD COLUMN     "unitName" TEXT;
