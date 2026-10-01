-- An administrator can mark an inspection area reviewed (the office, 2026-10-02).
--
-- "X of Y reviewed" counted an area only once all its findings were decided,
-- so an area with nothing wrong in it -- no finding to decide -- could never
-- count, and an occupied inspection read "0 of 20 reviewed" for good.
--
-- Nullable and additive, so the release before this one runs unchanged on it.

-- AlterTable
ALTER TABLE "InspectionArea" ADD COLUMN "reviewedAt" TIMESTAMP(3),
ADD COLUMN "reviewedById" UUID;
