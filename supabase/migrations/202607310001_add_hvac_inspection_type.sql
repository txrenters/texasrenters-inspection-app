-- Adds the HVAC inspection type.
--
-- Equipment maintenance rather than a tenancy lifecycle stage: it is scheduled
-- on its own cadence and is deliberately outside the
-- MOVE_IN -> OCCUPIED -> BACK_TO_MARKET -> MOVE_OUT chain, so it requires
-- neither a move-in baseline nor a predecessor inspection.
--
-- Additive and idempotent. Note that PostgreSQL cannot remove an enum value
-- once added, so this is not reversible by a down-migration.
ALTER TYPE "InspectionType" ADD VALUE IF NOT EXISTS 'HVAC';
