-- Jobber connection: one authorized Jobber account per organization.
--
-- Tokens are stored as AES-256-GCM envelopes (see src/common/secret-envelope.ts),
-- not as plaintext and not as hashes: a refresh token has to be replayed back to
-- Jobber months later, so it must be recoverable.

CREATE TYPE "JobberConnectionStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'REAUTHORIZATION_REQUIRED');

CREATE TABLE "JobberConnection" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "jobberAccountId" TEXT,
    "jobberAccountName" TEXT,
    "status" "JobberConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "accessTokenCiphertext" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenCiphertext" TEXT,
    "lastRefreshedAt" TIMESTAMP(3),
    "lastRefreshError" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "apiVersion" TEXT,
    "connectedByUserId" UUID,
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobberConnection_pkey" PRIMARY KEY ("id")
);

-- Unique, not just indexed: the scheduling source of record cannot be ambiguous.
-- Two Jobber accounts on one organization would mean two systems claiming to own
-- the same inspection calendar.
CREATE UNIQUE INDEX "JobberConnection_organizationId_key" ON "JobberConnection"("organizationId");

ALTER TABLE "JobberConnection" ADD CONSTRAINT "JobberConnection_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
