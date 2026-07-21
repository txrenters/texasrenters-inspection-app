-- Canonical Supabase migration for the read-only Propertyware integration.
-- Propertyware identifiers are never used as local primary keys.

-- The original inspection foundation may be managed by Prisma and may not have
-- been applied to a new Supabase project yet. Add snapshot support only when
-- that table already exists; do not make the Propertyware cache migration fail.
DO $migration$
BEGIN
  IF to_regclass('public."Inspection"') IS NOT NULL THEN
    ALTER TABLE public."Inspection"
      ADD COLUMN IF NOT EXISTS "propertySnapshot" JSONB;
  END IF;
END
$migration$;

CREATE TABLE "propertyware_portfolios" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "externalId" TEXT NOT NULL,
  "sourceSystem" TEXT NOT NULL DEFAULT 'propertyware',
  "idNumber" TEXT,
  "name" TEXT NOT NULL,
  "abbreviation" TEXT,
  "sourceStatus" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "sourceCreatedAt" TIMESTAMPTZ,
  "sourceUpdatedAt" TIMESTAMPTZ,
  "firstSyncedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastSyncedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deactivatedAt" TIMESTAMPTZ,
  "sourceHash" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "sourceSystem", "externalId")
);

CREATE TABLE "propertyware_owners" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "externalId" TEXT NOT NULL,
  "sourceSystem" TEXT NOT NULL DEFAULT 'propertyware',
  "displayName" TEXT NOT NULL,
  "sourceStatus" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "sourceCreatedAt" TIMESTAMPTZ,
  "sourceUpdatedAt" TIMESTAMPTZ,
  "firstSyncedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastSyncedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deactivatedAt" TIMESTAMPTZ,
  "sourceHash" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "sourceSystem", "externalId")
);

CREATE TABLE "propertyware_portfolio_owners" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "portfolioId" UUID NOT NULL REFERENCES "propertyware_portfolios"("id"),
  "ownerId" UUID NOT NULL REFERENCES "propertyware_owners"("id"),
  "percentageOwnership" DOUBLE PRECISION,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("portfolioId", "ownerId")
);

CREATE TABLE "propertyware_buildings" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "externalId" TEXT NOT NULL,
  "sourceSystem" TEXT NOT NULL DEFAULT 'propertyware',
  "portfolioId" UUID NOT NULL REFERENCES "propertyware_portfolios"("id"),
  "externalPortfolioId" TEXT NOT NULL,
  "idNumber" TEXT,
  "name" TEXT NOT NULL,
  "abbreviation" TEXT,
  "propertyType" TEXT,
  "addressLine1" TEXT,
  "addressLine2" TEXT,
  "city" TEXT,
  "state" TEXT,
  "postalCode" TEXT,
  "country" TEXT,
  "sourceStatus" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "sourceCreatedAt" TIMESTAMPTZ,
  "sourceUpdatedAt" TIMESTAMPTZ,
  "firstSyncedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastSyncedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deactivatedAt" TIMESTAMPTZ,
  "sourceHash" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "sourceSystem", "externalId")
);

CREATE TABLE "propertyware_units" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "externalId" TEXT NOT NULL,
  "sourceSystem" TEXT NOT NULL DEFAULT 'propertyware',
  "buildingId" UUID NOT NULL REFERENCES "propertyware_buildings"("id"),
  "portfolioId" UUID NOT NULL REFERENCES "propertyware_portfolios"("id"),
  "externalBuildingId" TEXT NOT NULL,
  "externalPortfolioId" TEXT NOT NULL,
  "idNumber" TEXT,
  "name" TEXT NOT NULL,
  "abbreviation" TEXT,
  "type" TEXT,
  "vacant" BOOLEAN,
  "publishedForRent" BOOLEAN,
  "bedrooms" INTEGER,
  "bathrooms" DOUBLE PRECISION,
  "addressLine1" TEXT,
  "addressLine2" TEXT,
  "city" TEXT,
  "state" TEXT,
  "postalCode" TEXT,
  "country" TEXT,
  "sourceStatus" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "sourceCreatedAt" TIMESTAMPTZ,
  "sourceUpdatedAt" TIMESTAMPTZ,
  "firstSyncedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastSyncedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deactivatedAt" TIMESTAMPTZ,
  "sourceHash" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "sourceSystem", "externalId")
);

CREATE TABLE "propertyware_leases" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "externalId" TEXT NOT NULL,
  "sourceSystem" TEXT NOT NULL DEFAULT 'propertyware',
  "portfolioId" UUID NOT NULL REFERENCES "propertyware_portfolios"("id"),
  "buildingId" UUID NOT NULL REFERENCES "propertyware_buildings"("id"),
  "unitId" UUID NOT NULL REFERENCES "propertyware_units"("id"),
  "externalPortfolioId" TEXT NOT NULL,
  "externalBuildingId" TEXT NOT NULL,
  "externalUnitId" TEXT NOT NULL,
  "idNumber" TEXT,
  "leaseName" TEXT,
  "sourceStatus" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "startDate" DATE,
  "endDate" DATE,
  "moveInDate" DATE,
  "scheduledMoveOutDate" DATE,
  "moveOutDate" DATE,
  "noticeGivenDate" DATE,
  "reasonForLeaving" TEXT,
  "tenantDisplayNames" TEXT[] NOT NULL DEFAULT '{}',
  "sourceCreatedAt" TIMESTAMPTZ,
  "sourceUpdatedAt" TIMESTAMPTZ,
  "firstSyncedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastSyncedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deactivatedAt" TIMESTAMPTZ,
  "sourceHash" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "sourceSystem", "externalId")
);

CREATE TABLE "propertyware_sync_cursors" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "entityType" TEXT NOT NULL,
  "lastSuccessfulCursor" TIMESTAMPTZ,
  "lastAttemptedCursor" TIMESTAMPTZ,
  "lastSuccessfulSyncAt" TIMESTAMPTZ,
  "lastFullReconciliationAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "entityType")
);

CREATE TABLE "propertyware_sync_runs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" UUID NOT NULL,
  "syncType" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "startedAt" TIMESTAMPTZ,
  "completedAt" TIMESTAMPTZ,
  "cursorStart" TIMESTAMPTZ,
  "cursorEnd" TIMESTAMPTZ,
  "recordsFetched" INTEGER NOT NULL DEFAULT 0,
  "recordsCreated" INTEGER NOT NULL DEFAULT 0,
  "recordsUpdated" INTEGER NOT NULL DEFAULT 0,
  "recordsUnchanged" INTEGER NOT NULL DEFAULT 0,
  "recordsDeactivated" INTEGER NOT NULL DEFAULT 0,
  "recordsReactivated" INTEGER NOT NULL DEFAULT 0,
  "recordsFailed" INTEGER NOT NULL DEFAULT 0,
  "pagesFetched" INTEGER NOT NULL DEFAULT 0,
  "errorSummary" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "propertyware_sync_run_entities" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "syncRunId" UUID NOT NULL REFERENCES "propertyware_sync_runs"("id"),
  "entityType" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "recordsFetched" INTEGER NOT NULL DEFAULT 0,
  "recordsCreated" INTEGER NOT NULL DEFAULT 0,
  "recordsUpdated" INTEGER NOT NULL DEFAULT 0,
  "recordsUnchanged" INTEGER NOT NULL DEFAULT 0,
  "recordsDeactivated" INTEGER NOT NULL DEFAULT 0,
  "recordsReactivated" INTEGER NOT NULL DEFAULT 0,
  "recordsFailed" INTEGER NOT NULL DEFAULT 0,
  "pagesFetched" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completedAt" TIMESTAMPTZ,
  UNIQUE ("syncRunId", "entityType")
);

CREATE TABLE "propertyware_sync_errors" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "syncRunId" UUID NOT NULL REFERENCES "propertyware_sync_runs"("id"),
  "entityType" TEXT NOT NULL,
  "externalId" TEXT,
  "pageOffset" INTEGER,
  "errorCode" TEXT NOT NULL,
  "sanitizedMessage" TEXT NOT NULL,
  "retryable" BOOLEAN NOT NULL DEFAULT FALSE,
  "payloadFingerprint" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "resolvedAt" TIMESTAMPTZ
);

CREATE TABLE "propertyware_sync_locks" (
  "lockKey" TEXT PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "propertyware_portfolios_active_name_idx" ON "propertyware_portfolios" ("organizationId", "isActive", "name");
CREATE INDEX "propertyware_buildings_active_name_idx" ON "propertyware_buildings" ("organizationId", "isActive", "name");
CREATE INDEX "propertyware_units_building_active_idx" ON "propertyware_units" ("organizationId", "buildingId", "isActive");
CREATE INDEX "propertyware_leases_unit_moveout_idx" ON "propertyware_leases" ("organizationId", "unitId", "isActive", "scheduledMoveOutDate");
CREATE INDEX "propertyware_sync_runs_created_idx" ON "propertyware_sync_runs" ("organizationId", "createdAt");
CREATE INDEX "propertyware_sync_errors_run_entity_idx" ON "propertyware_sync_errors" ("syncRunId", "entityType");

ALTER TABLE "propertyware_portfolios" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "propertyware_owners" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "propertyware_portfolio_owners" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "propertyware_buildings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "propertyware_units" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "propertyware_leases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "propertyware_sync_cursors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "propertyware_sync_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "propertyware_sync_run_entities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "propertyware_sync_errors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "propertyware_sync_locks" ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE "propertyware_portfolios" IS 'Read-only normalized Propertyware portfolio cache; backend service access only.';
COMMENT ON TABLE "propertyware_buildings" IS 'Read-only normalized Propertyware building cache; inactive records are retained.';
COMMENT ON TABLE "propertyware_units" IS 'Read-only normalized Propertyware unit cache; inactive records are retained.';
COMMENT ON TABLE "propertyware_leases" IS 'Read-only minimal Propertyware lease cache for move-out inspection workflows.';
