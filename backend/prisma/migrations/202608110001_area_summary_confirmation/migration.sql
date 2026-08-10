-- Records the technician's attestation that the AI's narrative summary for an
-- area matches the walkthrough they performed.
--
-- Deliberately separate from "InspectionFinding"."reviewedById"/"reviewedAt":
-- that pair records an administrator approving or rejecting a finding, and a
-- technician must never be able to write to it. These columns carry a weaker,
-- technician-scoped claim — "I read this and it reflects what I saw" — and
-- change no finding's review status.
--
-- Both nullable with no backfill: areas confirmed before this column existed
-- were never confirmed, and NULL is the honest record of that.
ALTER TABLE "InspectionArea" ADD COLUMN     "summaryConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "summaryConfirmedById" UUID;
