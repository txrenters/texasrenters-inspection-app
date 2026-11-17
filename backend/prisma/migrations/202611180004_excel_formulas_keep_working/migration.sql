-- The office's formulas keep working in the workbook (2026-11-18; the office
-- "can't use the formulas"). Since v2.5.245 the console gave every text cell
-- it wrote -- an empty one too -- Excel's Text format, where a typed formula
-- stays as words. Each tab now remembers the cells holding the office's
-- formulas, never to be written over, and when its old Text cells were put
-- right.

ALTER TABLE "ExcelSyncSheet" ADD COLUMN "formulaCells" JSONB;
ALTER TABLE "ExcelSyncSheet" ADD COLUMN "formatsCheckedAt" TIMESTAMP(3);
