-- A quarter's drive times can come from Mapbox.
--
-- The planner measured days against Google, and that account's billing lapsed
-- -- so every day fell back to a straight-line estimate and recorded itself as
-- HAVERSINE. The console then told the office, correctly and unhelpfully, that
-- no drive times could be measured for the day they were looking at.
--
-- Mapbox is asked for `driving` rather than `driving-traffic`, so this is
-- free-flow road time: the road network at its speed limits, not whatever the
-- traffic happened to be on the afternoon the quarter was built. That is what
-- the office asked for, and it also makes a quarter reproducible -- rebuilt
-- twice, it comes back the same.

-- AlterEnum
ALTER TYPE "DriveTimeSource" ADD VALUE IF NOT EXISTS 'MAPBOX_FREE_FLOW';
