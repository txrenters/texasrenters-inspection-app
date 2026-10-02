-- A reviewer adds what the AI missed (2026-10-03): a finding written by a
-- person, at a moment of the recording, decided as it is written. Kept apart
-- from the AI's own findings so the AI's scorecard is not credited with them,
-- and shown to the analysis as what it missed.
--
-- Additive only: one enum value. No existing finding changes source.

-- AlterEnum
ALTER TYPE "FindingSource" ADD VALUE IF NOT EXISTS 'REVIEWER';
