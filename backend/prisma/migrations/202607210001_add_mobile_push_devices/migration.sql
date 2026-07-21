CREATE TABLE "MobilePushDevice" (
    "id" UUID NOT NULL,
    "userProfileId" UUID NOT NULL,
    "expoPushToken" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobilePushDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MobilePushDevice_expoPushToken_key" ON "MobilePushDevice"("expoPushToken");
CREATE INDEX "MobilePushDevice_userProfileId_isActive_idx" ON "MobilePushDevice"("userProfileId", "isActive");

ALTER TABLE "MobilePushDevice" ADD CONSTRAINT "MobilePushDevice_userProfileId_fkey"
FOREIGN KEY ("userProfileId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
