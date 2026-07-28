-- Separates "where the bytes live" from "who the provider says this is".
-- providerMediaId doubled as the storage key, which blocked tenant-scoped keys
-- and any storage-backend change. Existing rows keep their current key, so no
-- object has to move.

ALTER TABLE "InspectionMedia" ADD COLUMN "storageKey" TEXT;

UPDATE "InspectionMedia" SET "storageKey" = "providerMediaId" WHERE "storageKey" IS NULL;

ALTER TABLE "InspectionMedia" ALTER COLUMN "storageKey" SET NOT NULL;

CREATE INDEX "InspectionMedia_storageKey_idx" ON "InspectionMedia"("storageKey");
