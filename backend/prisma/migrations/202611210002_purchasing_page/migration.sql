-- Purchasing Setup, part 5c (2026-11-21, from the approved PurchasingSetup
-- board): who makes and changes each code list, the requisition page's fields
-- and FactBoxes, and a list of units of measure.
--
-- Additive only. Empty keepers and an empty page read as they were before
-- Setup (decided with the office): stock lists kept by the stock keeper,
-- purchasing codes by the code admin, no field required.

-- A new kind of code. Its first codes are written by the next migration: a
-- value added to an enum is not used in the transaction that adds it.
ALTER TYPE "PurchasingCodeKind" ADD VALUE IF NOT EXISTS 'UNIT' AFTER 'LINE_TYPE';

ALTER TABLE "PurchasingSettings"
    ADD COLUMN "codeKeepers" JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN "requisitionPage" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "PurchasingSettings"
    ADD CONSTRAINT "PurchasingSettings_code_keepers_object" CHECK (jsonb_typeof("codeKeepers") = 'object'),
    ADD CONSTRAINT "PurchasingSettings_requisition_page_object" CHECK (jsonb_typeof("requisitionPage") = 'object');
