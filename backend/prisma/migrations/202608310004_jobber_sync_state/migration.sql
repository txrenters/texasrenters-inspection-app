-- Sync state for the Jobber pull.
--
-- On the connection rather than in its own table: there is exactly one Jobber
-- calendar per organization, so a run-history table would carry one meaningful
-- row. What anyone needs to know is whether it is running and whether the last
-- run worked.

ALTER TABLE "JobberConnection"
    ADD COLUMN "lastSyncStartedAt" TIMESTAMP(3),
    ADD COLUMN "lastSyncCompletedAt" TIMESTAMP(3),
    -- Sanitized message only. Jobber's own error bodies echo the request, which
    -- on the token endpoint carries the client secret.
    ADD COLUMN "lastSyncError" TEXT,
    ADD COLUMN "lastSyncVisitCount" INTEGER;
