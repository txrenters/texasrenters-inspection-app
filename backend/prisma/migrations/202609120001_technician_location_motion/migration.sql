-- Course and ground speed on a position report.
--
-- Both nullable, and both stay null for most of a working day: the platforms
-- only supply a heading while the device is actually travelling, and a phone
-- sitting on a kitchen counter reports neither. A backfill is impossible --
-- nothing already stored knows which way anybody was facing -- so every
-- existing row keeps null, which is the honest answer for it.
--
-- Row-level security is unchanged: the policy on this table keys on
-- "organizationId", and adding columns does not alter it.
ALTER TABLE "TechnicianLocationPing"
  ADD COLUMN "headingDegrees" INTEGER,
  ADD COLUMN "speedMetersPerSecond" DOUBLE PRECISION;
