-- Forward-only repair for environments where migration 002 was run manually,
-- partially applied, or encountered an unexpected schema order.

DO $$
BEGIN
  IF to_regclass('public.propertyware_sync_runs') IS NOT NULL THEN
    ALTER TABLE public."propertyware_sync_runs"
      ADD COLUMN IF NOT EXISTS "warnings" INTEGER NOT NULL DEFAULT 0;
  END IF;

  IF to_regclass('public.propertyware_sync_run_entities') IS NOT NULL THEN
    ALTER TABLE public."propertyware_sync_run_entities"
      ADD COLUMN IF NOT EXISTS "warnings" INTEGER NOT NULL DEFAULT 0;
  END IF;
END
$$;
