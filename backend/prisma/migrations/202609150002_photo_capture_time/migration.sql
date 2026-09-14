-- When a photograph was taken, what that rests on, and a fingerprint of the original.
--
-- `capturedAt` was the server's receipt for every photograph the app took -- the
-- phone never sent its capture time -- and, for imported reports, the stamp's
-- Texas wall-clock time read in whatever zone the importing machine was in.
-- These columns record provenance so a stamp is only ever drawn from a time
-- whose origin is known. Additive: the previous image ignores them.
CREATE TYPE "PhotoCaptureTimeSource" AS ENUM ('DEVICE_CLOCK', 'DEVICE_UPLOAD_KEY', 'REPORT_STAMP', 'VIDEO_OFFSET', 'SERVER_RECEIPT');

ALTER TABLE "InspectionPhoto"
  ADD COLUMN "captureTimeSource" "PhotoCaptureTimeSource",
  ADD COLUMN "deviceCapturedAt" TIMESTAMP(3),
  ADD COLUMN "captureTimeZone" TEXT,
  ADD COLUMN "captureUtcOffsetMinutes" INTEGER,
  ADD COLUMN "sha256" TEXT;

-- Photographs the app took: the phone's clock when the snapshot was saved is in
-- the upload key ("snapshot-<milliseconds>-..."), seconds after the shutter. On
-- 2026-09-14 every one of 335 such keys was earlier than its receipt (median 21
-- seconds, at most 11 minutes), so a key that is not is a wrong clock and is left
-- alone. Frames cut from recordings are excluded: their key holds the extraction.
UPDATE "InspectionPhoto"
SET "deviceCapturedAt" = (to_timestamp(substring("idempotencyKey" from '^snapshot-([0-9]{13})-')::bigint / 1000.0) AT TIME ZONE 'UTC'),
    "capturedAt" = (to_timestamp(substring("idempotencyKey" from '^snapshot-([0-9]{13})-')::bigint / 1000.0) AT TIME ZONE 'UTC'),
    "captureTimeSource" = 'DEVICE_UPLOAD_KEY'
WHERE "idempotencyKey" ~ '^snapshot-[0-9]{13}-'
  AND coalesce("metadata"->>'captureSource', '') <> 'VIDEO_FRAME_EXTRACTION'
  AND (to_timestamp(substring("idempotencyKey" from '^snapshot-([0-9]{13})-')::bigint / 1000.0) AT TIME ZONE 'UTC')
      BETWEEN "createdAt" - INTERVAL '30 days' AND "createdAt" + INTERVAL '2 minutes';

-- Everything else captured here: the receipt is all that is known. Imported
-- photographs stay unconfirmed until their report is re-read
-- (scripts/reparse-imported-photo-times.mjs); shifting them here would be wrong
-- for the reports that were imported from a machine outside UTC.
UPDATE "InspectionPhoto"
SET "captureTimeSource" = 'SERVER_RECEIPT'
WHERE "captureTimeSource" IS NULL
  AND NOT (coalesce("metadata", '{}'::jsonb) ? 'importedFrom');
