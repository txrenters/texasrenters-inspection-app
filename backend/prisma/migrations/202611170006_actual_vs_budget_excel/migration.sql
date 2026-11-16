-- Actual vs Budget kept in step with the office's own workbook (2026-11-17).
-- The office's Microsoft account, connected once (sealed tokens, as Xero's),
-- the workbook and the sync's switch, and what the console last wrote into
-- each tab. Microsoft's calls are not billed.

CREATE TABLE "MicrosoftConnection" (
    "organizationId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "accountEmail" TEXT,
    "accountName" TEXT,
    "accessTokenCiphertext" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenCiphertext" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connectedByUserId" UUID,
    "connectedAt" TIMESTAMP(3),
    "lastRefreshedAt" TIMESTAMP(3),
    "lastRefreshError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MicrosoftConnection_pkey" PRIMARY KEY ("organizationId"),
    CONSTRAINT "MicrosoftConnection_status_known" CHECK ("status" IN ('CONNECTED', 'REAUTHORIZATION_REQUIRED', 'DISCONNECTED'))
);
ALTER TABLE "MicrosoftConnection" ADD CONSTRAINT "MicrosoftConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ExcelSync" (
    "organizationId" UUID NOT NULL,
    "shareUrl" TEXT NOT NULL,
    "driveId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "webUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "startDate" DATE NOT NULL,
    "dirtyAt" TIMESTAMP(3),
    "lastPushedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "claimedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExcelSync_pkey" PRIMARY KEY ("organizationId")
);
ALTER TABLE "ExcelSync" ADD CONSTRAINT "ExcelSync_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ExcelSyncSheet" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rows" JSONB NOT NULL,
    "bold" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExcelSyncSheet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExcelSyncSheet_organizationId_name_key" ON "ExcelSyncSheet"("organizationId", "name");
ALTER TABLE "ExcelSyncSheet" ADD CONSTRAINT "ExcelSyncSheet_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MicrosoftConnection" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "MicrosoftConnection"
  USING (current_setting('app.organization_id', true) = '*' OR "organizationId"::text = current_setting('app.organization_id', true));
ALTER TABLE "ExcelSync" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ExcelSync"
  USING (current_setting('app.organization_id', true) = '*' OR "organizationId"::text = current_setting('app.organization_id', true));
ALTER TABLE "ExcelSyncSheet" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ExcelSyncSheet"
  USING (current_setting('app.organization_id', true) = '*' OR "organizationId"::text = current_setting('app.organization_id', true));
