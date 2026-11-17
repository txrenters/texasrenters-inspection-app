-- Actual vs Budget reads the office's edits back from Excel (2026-11-18; the
-- office chose "Both ways"). The workbook's version after the console's last
-- write tells whether anyone has edited it since; each tab the console wrote
-- keeps which row is whose and which of its columns the office may type in.

ALTER TABLE "ExcelSync" ADD COLUMN "fileTag" TEXT;
ALTER TABLE "ExcelSync" ADD COLUMN "lastPulledAt" TIMESTAMP(3);
ALTER TABLE "ExcelSync" ADD COLUMN "lastPull" JSONB;
ALTER TABLE "ExcelSyncSheet" ADD COLUMN "keys" JSONB;
ALTER TABLE "ExcelSyncSheet" ADD COLUMN "editable" JSONB;
