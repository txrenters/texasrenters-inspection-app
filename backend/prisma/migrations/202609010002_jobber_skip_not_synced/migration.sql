-- A visit whose type this integration deliberately does not import.
--
-- Filter delivery is the case that prompted it: the app models it as an
-- inspection type, but it is a delivery — nobody inspects anything — so a
-- technician should not be handed one as an inspection.
--
-- Its own status rather than REJECTED, because the console's work queue shows
-- rejections and this is not a problem to solve: it is a decision, already made,
-- that would otherwise reappear as ~100 rows of noise on every sync.
ALTER TYPE "JobberVisitImportStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_NOT_SYNCED';
