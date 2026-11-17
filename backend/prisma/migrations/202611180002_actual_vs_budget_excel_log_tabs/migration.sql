-- Actual vs Budget writes each technician's own log tab too (2026-11-18, the
-- office changed a Job# on the page and looked for it in Excel). The console's
-- rows go under the office's: the sheet row they start at is kept, so they are
-- found again, and the office's rows above are never written.

ALTER TABLE "ExcelSyncSheet" ADD COLUMN "origin" INTEGER;
