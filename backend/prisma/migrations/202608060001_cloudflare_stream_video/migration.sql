-- Cloudflare Stream becomes the upload and playback path for inspection video.
--
-- Purely additive. Every column is nullable or defaulted and no existing value
-- is rewritten, so recordings made before this migration keep their R2
-- `storageKey` and keep playing from it. A record is Stream-backed if and only
-- if `streamUid` is set, which is why no backfill is required and no evidence
-- is stranded mid-migration.

-- Postgres will not let a new enum value be used in the same transaction that
-- adds it, so this statement is applied on its own ahead of the table change.
ALTER TYPE "MediaUploadStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "InspectionMedia"
  ADD COLUMN "streamUid"            TEXT,
  ADD COLUMN "uploadBytesTotal"     INTEGER,
  ADD COLUMN "uploadBytesCompleted" INTEGER,
  ADD COLUMN "originalFilename"     TEXT,
  ADD COLUMN "recordedAt"           TIMESTAMP(3),
  ADD COLUMN "uploadedAt"           TIMESTAMP(3),
  ADD COLUMN "readyAt"              TIMESTAMP(3),
  ADD COLUMN "failedAt"             TIMESTAMP(3),
  ADD COLUMN "failureCode"          TEXT,
  ADD COLUMN "failureMessage"       TEXT,
  ADD COLUMN "retryCount"           INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "localQueueId"         TEXT,
  ADD COLUMN "thumbnailUrl"         TEXT,
  ADD COLUMN "widthPx"              INTEGER,
  ADD COLUMN "heightPx"             INTEGER;

-- A Stream-backed video never passes through this backend and has no bucket
-- object. Pre-migration rows all still carry theirs.
ALTER TABLE "InspectionMedia" ALTER COLUMN "storageKey" DROP NOT NULL;

-- The webhook looks a video up by this, so it must be unique and indexed.
CREATE UNIQUE INDEX "InspectionMedia_streamUid_key" ON "InspectionMedia"("streamUid");
