-- Supabase mirror of Prisma migration 202607250007_media_storage_key.
-- Separates the storage key from the provider media id on InspectionMedia.

ALTER TABLE "InspectionMedia" ADD COLUMN IF NOT EXISTS "storageKey" TEXT;

UPDATE "InspectionMedia" SET "storageKey" = "providerMediaId" WHERE "storageKey" IS NULL;

ALTER TABLE "InspectionMedia" ALTER COLUMN "storageKey" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "InspectionMedia_storageKey_idx" ON "InspectionMedia"("storageKey");
