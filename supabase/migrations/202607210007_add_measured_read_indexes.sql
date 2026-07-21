-- Supports the administrator inspection list filtered by organization and ordered by schedule.
-- The pre-change development plan required an explicit Sort beneath Limit.
CREATE INDEX IF NOT EXISTS "Inspection_organizationId_scheduledAt_idx"
  ON public."Inspection" ("organizationId", "scheduledAt" DESC);

-- Supports the dashboard's latest successful Propertyware synchronization lookup.
-- The pre-change development plan required an explicit Sort beneath Limit.
CREATE INDEX IF NOT EXISTS "propertyware_sync_runs_org_status_completed_idx"
  ON public."propertyware_sync_runs" ("organizationId", "status", "completedAt" DESC);

-- Operational note: standard CREATE INDEX takes a ShareLock while building. Apply during a
-- controlled deployment window for a large production table; this migration is not auto-applied.

