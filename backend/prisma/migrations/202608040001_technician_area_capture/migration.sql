-- Lets an inspection be scheduled on a property with no approved floor plan,
-- with the technician surveying the areas on site.
--
-- Without this, scheduling was blocked outright by NO_APPROVED_AREAS and the
-- only way through was a single "Entire property" fallback area, which loses
-- the per-area structure the whole review is organised around.
--
-- Defaults to false: an inspection on a property that already has an approved
-- layout keeps using it, and this stays an explicit choice made per inspection.
ALTER TABLE "Inspection"
  ADD COLUMN "allowTechnicianAreaCapture" BOOLEAN NOT NULL DEFAULT false;
