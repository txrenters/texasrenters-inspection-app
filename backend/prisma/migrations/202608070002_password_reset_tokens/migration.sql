-- Password-reset tokens, replacing Supabase's generateLink({ type: 'recovery' }).
-- Phase 2d of docs/migration/SUPABASE_TO_SELF_HOSTED.md.
--
-- Additive only. Nothing reads this yet; the reset flow still runs through
-- Supabase until AUTH_IDENTITY_PROVIDER is switched.

CREATE TABLE "AuthPasswordResetToken" (
    "id" UUID NOT NULL,
    "authUserId" TEXT NOT NULL,
    -- SHA-256, never the token. The row is a live credential until redeemed,
    -- so a leaked backup must not be usable.
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    -- Kept after redemption rather than deleted, so a second attempt is
    -- distinguishable from a token that never existed.
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthPasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthPasswordResetToken_tokenHash_key" ON "AuthPasswordResetToken"("tokenHash");
CREATE INDEX "AuthPasswordResetToken_authUserId_idx" ON "AuthPasswordResetToken"("authUserId");
CREATE INDEX "AuthPasswordResetToken_expiresAt_idx" ON "AuthPasswordResetToken"("expiresAt");

ALTER TABLE "AuthPasswordResetToken" ADD CONSTRAINT "AuthPasswordResetToken_authUserId_fkey"
    FOREIGN KEY ("authUserId") REFERENCES "AuthCredential"("authUserId")
    ON DELETE CASCADE ON UPDATE CASCADE;
