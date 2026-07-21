-- Forward-only follow-up: the initial Propertyware migration may already be applied.
-- Warnings are tracked separately from failures so zero-record runs remain truthful.

ALTER TABLE "propertyware_sync_runs"
  ADD COLUMN IF NOT EXISTS "warnings" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "propertyware_sync_run_entities"
  ADD COLUMN IF NOT EXISTS "warnings" INTEGER NOT NULL DEFAULT 0;
