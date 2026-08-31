-- Jobber becomes a second source of inspections, alongside manual booking.
--
-- Every column here is additive and nullable (or defaulted), so existing rows
-- keep meaning exactly what they meant: `source` defaults to MANUAL, and the
-- visit times are NULL for anything not booked in Jobber.

CREATE TYPE "InspectionSource" AS ENUM ('MANUAL', 'JOBBER');

ALTER TABLE "Inspection"
    ADD COLUMN "source" "InspectionSource" NOT NULL DEFAULT 'MANUAL',
    -- Jobber sends a clock time; `scheduledAt` stays DATE. Widening it instead
    -- would give every historical inspection a midnight nobody scheduled.
    ADD COLUMN "scheduledStartAt" TIMESTAMP(3),
    ADD COLUMN "scheduledEndAt" TIMESTAMP(3),
    ADD COLUMN "jobberVisitId" TEXT,
    ADD COLUMN "jobberJobId" TEXT,
    -- Jobber's own last-modified stamp. Compared against instead of our
    -- `updatedAt`, which moves whenever a technician touches the inspection and
    -- would make ordinary local progress look newer than a real reschedule.
    ADD COLUMN "jobberUpdatedAt" TIMESTAMP(3);

-- One inspection per Jobber visit. Postgres permits many NULLs in a unique
-- index, so manually booked inspections are unaffected, but a visit that syncs
-- twice cannot become two inspections.
CREATE UNIQUE INDEX "Inspection_organizationId_jobberVisitId_key"
    ON "Inspection"("organizationId", "jobberVisitId");
