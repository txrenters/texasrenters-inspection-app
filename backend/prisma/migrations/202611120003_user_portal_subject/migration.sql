-- Sign in with TR Staff Portal (2026-11-12): the portal's stable id for a
-- person, written the first time they sign in through it. Nullable, because
-- nobody has one until then; unique, so one portal identity opens one account.
ALTER TABLE "UserProfile" ADD COLUMN "portalSubject" TEXT;

CREATE UNIQUE INDEX "UserProfile_portalSubject_key" ON "UserProfile"("portalSubject");
