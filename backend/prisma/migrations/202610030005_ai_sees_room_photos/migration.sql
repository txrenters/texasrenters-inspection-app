-- The AI's look at a recording also looks at the technician's still photos
-- of the room (2026-10-03), which are sharper than any frame of a moving phone
-- video. The photos it saw a finding in are kept on the finding, to show the
-- reviewer beside it.
--
-- Additive only: one column, empty for every existing finding.

-- AlterTable
ALTER TABLE "InspectionFinding"
  ADD COLUMN "visualPhotoIds" UUID[] DEFAULT ARRAY[]::UUID[];
