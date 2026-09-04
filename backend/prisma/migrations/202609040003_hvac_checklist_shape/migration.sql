-- The office's HVAC form asks for things a tick cannot express: eight numeric
-- readings (a temperature split is a diagnosis), two free-text lines, and three
-- single-choice answers. It also prints eleven named sections, which the flat
-- sortOrder could not represent.
--
-- All additive. Every existing row is a STATUS item in an unnamed section,
-- which is exactly what the default gives it.

CREATE TYPE "ChecklistResponseType" AS ENUM ('STATUS', 'READING', 'TEXT', 'CHOICE');

ALTER TABLE "AreaChecklistItem"
  ADD COLUMN "section" TEXT,
  ADD COLUMN "responseType" "ChecklistResponseType" NOT NULL DEFAULT 'STATUS',
  ADD COLUMN "unit" TEXT,
  ADD COLUMN "choices" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Decimal, not double precision: these are compared between visits and printed
-- on a report, and binary floating point belongs in neither.
ALTER TABLE "InspectionAreaChecklistResponse"
  ADD COLUMN "numericValue" DECIMAL(10,2),
  ADD COLUMN "textValue" TEXT;
