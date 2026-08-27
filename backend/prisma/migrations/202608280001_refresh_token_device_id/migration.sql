-- Which handset a session belongs to.
--
-- Single-device enforcement compared "is any live refresh token present",
-- which cannot tell a reinstall from a second phone: uninstalling the app
-- never reaches the server, so the token outlived it and a technician who
-- reinstalled was told to take their own device over.
--
-- Nullable, and no backfill: every existing session predates the column and is
-- genuinely unknown. An unknown device never matches, so those sessions keep
-- today's behaviour until they expire or are replaced.
ALTER TABLE "AuthRefreshToken" ADD COLUMN "deviceId" TEXT;

-- The lookup is "is this account live on a device other than this one", which
-- reads by account and then compares.
CREATE INDEX "AuthRefreshToken_authUserId_deviceId_idx"
  ON "AuthRefreshToken" ("authUserId", "deviceId");
