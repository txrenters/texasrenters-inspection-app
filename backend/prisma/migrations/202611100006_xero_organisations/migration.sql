-- Several Xero organisations for one office (2026-11-10, phase 1 of the
-- multi-company plan): THMP, Crystal Creek Pest, Crystal Creek Air and the
-- like each keep their own books in Xero. One sign-in reaches all of them --
-- Xero's tokens are for the person and the app, and each call names the
-- organisation it is for -- so the sign-in stays one per office, and what was
-- one organisation's becomes a row per organisation: its details, chart of
-- accounts and tax rates, and its own count of calls, as Xero limits each
-- organisation separately.
CREATE TABLE "XeroOrganisation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "xeroTenantId" TEXT NOT NULL,
    -- Xero's id for this app's link to the organisation, which a disconnect removes.
    "xeroConnectionId" TEXT,
    "name" TEXT NOT NULL,
    -- CONNECTED, or REMOVED when the latest sign-in no longer reaches it or it was disconnected.
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "organisation" JSONB,
    "accounts" JSONB,
    "taxRates" JSONB,
    "catalogReadAt" TIMESTAMP(3),
    "catalogReadError" TEXT,
    "callsDay" TEXT,
    "callsUsed" INTEGER NOT NULL DEFAULT 0,
    "connectedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroOrganisation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "XeroOrganisation_organizationId_xeroTenantId_key" ON "XeroOrganisation"("organizationId", "xeroTenantId");

ALTER TABLE "XeroOrganisation" ADD CONSTRAINT "XeroOrganisation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "XeroOrganisation" ADD CONSTRAINT "XeroOrganisation_status_known" CHECK ("status" IN ('CONNECTED', 'REMOVED'));
ALTER TABLE "XeroOrganisation" ADD CONSTRAINT "XeroOrganisation_calls_counted" CHECK ("callsUsed" >= 0);

ALTER TABLE "XeroOrganisation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "XeroOrganisation"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

-- The one organisation an office may already have connected becomes the first of its rows.
INSERT INTO "XeroOrganisation" (
    "id", "organizationId", "xeroTenantId", "xeroConnectionId", "name", "status",
    "organisation", "accounts", "taxRates", "catalogReadAt", "catalogReadError",
    "callsDay", "callsUsed", "connectedAt", "removedAt", "createdAt", "updatedAt"
)
SELECT gen_random_uuid(), "organizationId", "xeroTenantId", "xeroConnectionId", COALESCE("xeroTenantName", 'Xero organisation'),
       CASE WHEN "status" = 'CONNECTED' THEN 'CONNECTED' ELSE 'REMOVED' END,
       "organisation", "accounts", "taxRates", "catalogReadAt", "catalogReadError",
       "callsDay", "callsUsed", "connectedAt", CASE WHEN "status" = 'CONNECTED' THEN NULL ELSE "disconnectedAt" END,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "XeroConnection"
 WHERE "xeroTenantId" IS NOT NULL;

-- The choices -- start date, accounts, tax type -- are each organisation's own: its own chart of accounts.
ALTER TABLE "XeroSettings" ADD COLUMN "xeroTenantId" TEXT;
UPDATE "XeroSettings" AS s
   SET "xeroTenantId" = c."xeroTenantId"
  FROM "XeroConnection" AS c
 WHERE c."organizationId" = s."organizationId";
-- Choices made with no organisation behind them have nothing to point at.
DELETE FROM "XeroSettings" WHERE "xeroTenantId" IS NULL;
ALTER TABLE "XeroSettings" ALTER COLUMN "xeroTenantId" SET NOT NULL;
ALTER TABLE "XeroSettings" DROP CONSTRAINT "XeroSettings_pkey";
ALTER TABLE "XeroSettings" ADD CONSTRAINT "XeroSettings_pkey" PRIMARY KEY ("organizationId", "xeroTenantId");
ALTER TABLE "XeroSettings" ADD CONSTRAINT "XeroSettings_organizationId_xeroTenantId_fkey" FOREIGN KEY ("organizationId", "xeroTenantId") REFERENCES "XeroOrganisation"("organizationId", "xeroTenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- The sign-in keeps only what is the sign-in's.
ALTER TABLE "XeroConnection" DROP CONSTRAINT IF EXISTS "XeroConnection_calls_counted";
ALTER TABLE "XeroConnection"
  DROP COLUMN "xeroTenantId",
  DROP COLUMN "xeroTenantName",
  DROP COLUMN "xeroConnectionId",
  DROP COLUMN "organisation",
  DROP COLUMN "accounts",
  DROP COLUMN "taxRates",
  DROP COLUMN "catalogReadAt",
  DROP COLUMN "catalogReadError",
  DROP COLUMN "callsDay",
  DROP COLUMN "callsUsed";
