-- Errors from the handset and the console, collected somewhere a person can read them.
--
-- `organizationId` is nullable on purpose: an error raised before anybody signs
-- in has no organization, and those are the ones most worth keeping. The unique
-- pair below is what lets a client re-send its whole log without creating
-- duplicates, so the flush can be at-least-once.

CREATE TYPE "ClientErrorSource" AS ENUM ('MOBILE', 'CONSOLE');

CREATE TABLE "ClientErrorReport" (
    "id" UUID NOT NULL,
    "organizationId" UUID,
    "authUserId" TEXT,
    "source" "ClientErrorSource" NOT NULL,
    "clientEntryId" TEXT NOT NULL,
    "installId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "context" TEXT,
    "fatal" BOOLEAN NOT NULL DEFAULT false,
    "platform" TEXT,
    "appVersion" TEXT,
    "buildId" TEXT,
    "apiBaseUrl" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientErrorReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClientErrorReport_installId_clientEntryId_key"
    ON "ClientErrorReport"("installId", "clientEntryId");

CREATE INDEX "ClientErrorReport_organizationId_receivedAt_idx"
    ON "ClientErrorReport"("organizationId", "receivedAt");

CREATE INDEX "ClientErrorReport_source_receivedAt_idx"
    ON "ClientErrorReport"("source", "receivedAt");

ALTER TABLE "ClientErrorReport"
    ADD CONSTRAINT "ClientErrorReport_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
