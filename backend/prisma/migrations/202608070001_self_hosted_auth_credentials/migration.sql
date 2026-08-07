-- Self-hosted sign-in credentials, replacing Supabase's `auth.users`.
-- Phase 2 of docs/migration/SUPABASE_TO_SELF_HOSTED.md.
--
-- Additive only. Nothing here changes an existing table, and no code reads
-- these tables yet, so applying it is safe while Supabase Auth is still live.
--
-- Hand-written rather than generated: `migrate dev` cannot replay this repo's
-- history against a shadow database, and `migrate diff` surfaces a large amount
-- of pre-existing drift that is not part of this change.

CREATE TABLE "AuthCredential" (
    "id" UUID NOT NULL,
    -- The SAME value Supabase issued, so every UserProfile link and every JWT
    -- `sub` already in circulation stays valid.
    "authUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    -- bcrypt; Supabase's $2a$ hashes import unchanged.
    "passwordHash" TEXT NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "lastSignInAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuthRefreshToken" (
    "id" UUID NOT NULL,
    "authUserId" TEXT NOT NULL,
    -- SHA-256 of the token, never the token itself: this table is the list of
    -- live sessions, and plaintext here would be as good as a password.
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    -- Set on rotation. A token presented after being replaced is a replay,
    -- which is only detectable because the used row is kept, not deleted.
    "replacedById" UUID,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthRefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthCredential_authUserId_key" ON "AuthCredential"("authUserId");
CREATE UNIQUE INDEX "AuthCredential_email_key" ON "AuthCredential"("email");
CREATE INDEX "AuthCredential_email_idx" ON "AuthCredential"("email");

CREATE UNIQUE INDEX "AuthRefreshToken_tokenHash_key" ON "AuthRefreshToken"("tokenHash");
CREATE INDEX "AuthRefreshToken_authUserId_idx" ON "AuthRefreshToken"("authUserId");
CREATE INDEX "AuthRefreshToken_expiresAt_idx" ON "AuthRefreshToken"("expiresAt");

-- A true 1:1 with the profile. `UserProfile.authUserId` is unique, so the
-- database now enforces what used to be convention spanning two systems: a
-- credential cannot exist for a profile that does not, and deleting the profile
-- takes the credential and every session with it.
ALTER TABLE "AuthCredential" ADD CONSTRAINT "AuthCredential_authUserId_fkey"
    FOREIGN KEY ("authUserId") REFERENCES "UserProfile"("authUserId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuthRefreshToken" ADD CONSTRAINT "AuthRefreshToken_authUserId_fkey"
    FOREIGN KEY ("authUserId") REFERENCES "AuthCredential"("authUserId")
    ON DELETE CASCADE ON UPDATE CASCADE;
