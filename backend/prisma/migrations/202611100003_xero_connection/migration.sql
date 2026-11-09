-- Connecting the office's Xero organisation (2026-11-10, phase 1 of the Xero
-- plan): the OAuth tokens, sealed with their own key; which organisation it
-- is; and what was last read from it -- its details, chart of accounts and
-- tax rates -- so the console shows them without asking Xero again. Read
-- only: nothing is written to Xero in this phase. Additive.

CREATE TABLE "XeroConnection" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "xeroTenantId" TEXT,
    "xeroTenantName" TEXT,
    "xeroConnectionId" TEXT,
    "accessTokenCiphertext" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenCiphertext" TEXT,
    "lastRefreshedAt" TIMESTAMP(3),
    "lastRefreshError" TEXT,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "connectedByUserId" UUID,
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "organisation" JSONB,
    "accounts" JSONB,
    "taxRates" JSONB,
    "catalogReadAt" TIMESTAMP(3),
    "catalogReadError" TEXT,
    "callsDay" TEXT,
    "callsUsed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "XeroConnection_organizationId_key" ON "XeroConnection"("organizationId");

ALTER TABLE "XeroConnection" ADD CONSTRAINT "XeroConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "XeroConnection" ADD CONSTRAINT "XeroConnection_status_known" CHECK (
  "status" IN ('DISCONNECTED', 'CONNECTED', 'REAUTHORIZATION_REQUIRED')
);
ALTER TABLE "XeroConnection" ADD CONSTRAINT "XeroConnection_calls_counted" CHECK ("callsUsed" >= 0);

ALTER TABLE "XeroConnection" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "XeroConnection"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
