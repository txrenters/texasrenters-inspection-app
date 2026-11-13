-- Submit a move-in or move-out while its room videos are still sending
-- (2026-11-14). End job may now name the videos the phone has not finished
-- sending; the inspection waits for them until this moment, then goes to review
-- without those that never arrived, flagged for the office. Null when nothing
-- is awaited, which is every inspection before this and nearly every one after.
-- Additive: one nullable column and a partial index for the sweep that ends
-- waits that ran out.

-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "lateVideosUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Inspection_lateVideosUntil_idx" ON "Inspection"("lateVideosUntil") WHERE "lateVideosUntil" IS NOT NULL;
