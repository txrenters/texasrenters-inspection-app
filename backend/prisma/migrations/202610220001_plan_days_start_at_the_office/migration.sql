-- A planned benefit-package day starts at the office now (2026-10-22), not at
-- the technician's home. Days measured from now on say so; a day measured
-- before keeps HOME, which is still true of how its drive was measured.
--
-- Additive only: one enum value. No existing day changes kind.

-- AlterEnum
ALTER TYPE "PlanOriginKind" ADD VALUE IF NOT EXISTS 'OFFICE';
