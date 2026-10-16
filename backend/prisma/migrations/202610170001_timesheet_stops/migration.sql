-- Stops away from the properties on the timesheet (the office, 2026-10-17).
--
-- Between two properties the timesheet had one figure, general time, and a
-- supply run to the hardware store was hidden inside the drive. A stop is now
-- a stretch of its own: somewhere that is not a property, where the technician
-- stood still for five minutes or more. It is its own figure on the timesheet,
-- and only the people who may see a technician's position see where it was.
--
--   * "TimeSegmentCategory" gains STOP.
--   * Where the stop was, and what it was once looked up. The position is
--     erased with the trail after the retention window; the name stays with
--     the hours.
--
-- Additive: one enum value, one new enum, nullable columns on an existing
-- table whose tenant policy already covers them. Nothing here uses the new
-- enum value, which Postgres does not allow in the transaction that adds it.

-- AlterEnum
ALTER TYPE "TimeSegmentCategory" ADD VALUE IF NOT EXISTS 'STOP';

-- CreateEnum
CREATE TYPE "TimeStopPlaceKind" AS ENUM ('PROPERTY', 'HOME', 'BUSINESS', 'ADDRESS', 'UNKNOWN');

-- AlterTable
ALTER TABLE "TimeSegment"
  ADD COLUMN IF NOT EXISTS "placeLatitude" DECIMAL(9,6),
  ADD COLUMN IF NOT EXISTS "placeLongitude" DECIMAL(9,6),
  ADD COLUMN IF NOT EXISTS "placeKind" "TimeStopPlaceKind",
  ADD COLUMN IF NOT EXISTS "placeName" TEXT,
  ADD COLUMN IF NOT EXISTS "placeAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "placeNamedAt" TIMESTAMP(3);
