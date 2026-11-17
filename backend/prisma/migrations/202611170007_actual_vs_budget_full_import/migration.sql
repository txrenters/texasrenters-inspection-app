-- Actual vs Budget takes in all of the office's workbook (2026-11-17, the
-- office: "I want all the data imported too"). Each entry the import wrote
-- keeps what it wrote, field by field, so importing again replaces only what
-- the office has not changed in the console since.

ALTER TABLE "RevenueLogEntry" ADD COLUMN "importedFields" JSONB;
ALTER TABLE "RevenueDayEntry" ADD COLUMN "importedFields" JSONB;
ALTER TABLE "RevenueWeekEntry" ADD COLUMN "importedFields" JSONB;
ALTER TABLE "RevenueMonthEntry" ADD COLUMN "importedFields" JSONB;
