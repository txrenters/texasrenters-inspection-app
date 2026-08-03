-- Inspections are scheduled to a day, never a time.
--
-- The column held a timestamp, so the UI offered an hour and minute that no
-- part of the workflow used: a technician is assigned a date, and every
-- comparison in the app already reduced the value to a calendar day.
--
-- Cast at the database's own timezone rather than UTC. Existing rows were
-- written from local input, so `AT TIME ZONE` here keeps an inspection booked
-- for the 3rd on the 3rd, instead of shifting an evening booking to the 4th or
-- an early-morning one to the 2nd.
ALTER TABLE "Inspection"
  ALTER COLUMN "scheduledAt" TYPE DATE
  USING ("scheduledAt" AT TIME ZONE 'UTC')::DATE;
