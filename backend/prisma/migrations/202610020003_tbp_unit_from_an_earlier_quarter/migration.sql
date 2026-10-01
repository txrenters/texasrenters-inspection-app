-- A quarter remembers the unit a tenancy's visit had in an earlier one (the office, 2026-10-02).
--
-- A unit chosen by hand was kept on that quarter's visit only, so the same
-- multi-unit building asked for its units again every quarter, and sat in
-- "Needs attention" until somebody chose them again. A unit found this way is
-- PRIOR_QUARTER.
--
-- PRIOR_QUARTER is added and not used here: Postgres will not let a value added
-- by ALTER TYPE be used in the same transaction, and Prisma runs a migration in one.

-- AlterEnum
ALTER TYPE "TbpUnitResolution" ADD VALUE 'PRIOR_QUARTER';
