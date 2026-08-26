-- Third-party API access: registered integrations and the keys they authenticate with.
--
-- The principal a machine credential resolves to is deliberately shaped like a
-- human one — one organization, a set of permission keys — so PermissionsGuard,
-- the tenant interceptor and the row-level security policies below all apply to
-- third-party traffic unchanged. A second authorization path for machines is
-- exactly the kind of thing that drifts out of step with the first one.

CREATE TYPE "ApiClientEnvironment" AS ENUM ('LIVE', 'TEST');

CREATE TABLE "ApiClient" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "environment" "ApiClientEnvironment" NOT NULL DEFAULT 'LIVE',
    -- A subset of the permission catalog. The keys a machine may never hold are
    -- refused when the client is created, not merely when it calls.
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 60,
    "requireSignature" BOOLEAN NOT NULL DEFAULT false,
    "allowedIps" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiClient_pkey" PRIMARY KEY ("id")
);

-- A rate limit of zero would silently deny every request, and a negative one is
-- meaningless. The ceiling is not a performance guess: it is the point past
-- which an integration should be talking to us about a bulk export instead.
ALTER TABLE "ApiClient" ADD CONSTRAINT "ApiClient_rateLimitPerMinute_check"
  CHECK ("rateLimitPerMinute" BETWEEN 1 AND 6000);

-- One integration, one name, per organization: the name is what an operator
-- revokes by under pressure, so two clients sharing one is a real hazard.
CREATE UNIQUE INDEX "ApiClient_organizationId_name_key" ON "ApiClient"("organizationId", "name");
CREATE INDEX "ApiClient_organizationId_isActive_idx" ON "ApiClient"("organizationId", "isActive");

ALTER TABLE "ApiClient" ADD CONSTRAINT "ApiClient_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ApiClientKey" (
    "id" UUID NOT NULL,
    "apiClientId" UUID NOT NULL,
    -- Denormalised from the client so the policy below can police this table
    -- with the same predicate as every other one, without a join.
    "organizationId" UUID NOT NULL,
    -- The non-secret half of the credential: indexed for the lookup, and safe to
    -- print in a console or a log line.
    "prefix" TEXT NOT NULL,
    -- A keyed hash of the other half. The secret itself is shown once, at
    -- creation, and never stored anywhere.
    "secretHash" TEXT NOT NULL,
    "label" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiClientKey_pkey" PRIMARY KEY ("id")
);

-- Globally unique, not per-organization. The prefix is what an inbound request
-- is resolved by before any tenant is known, so a collision across two
-- organizations would be a cross-tenant authentication ambiguity.
CREATE UNIQUE INDEX "ApiClientKey_prefix_key" ON "ApiClientKey"("prefix");
CREATE INDEX "ApiClientKey_apiClientId_revokedAt_idx" ON "ApiClientKey"("apiClientId", "revokedAt");

ALTER TABLE "ApiClientKey" ADD CONSTRAINT "ApiClientKey_apiClientId_fkey" FOREIGN KEY ("apiClientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiClientKey" ADD CONSTRAINT "ApiClientKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Which machine acted. `actorUserId` is null for every key-authenticated
-- request, so without this column a third-party write is indistinguishable from
-- an anonymous one — and "who changed this" is the entire point of the table.
ALTER TABLE "AuditLog" ADD COLUMN "actorApiClientId" UUID;

-- Tenant isolation, matching every other table that carries an organizationId.
ALTER TABLE "ApiClient" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ApiClient";
CREATE POLICY tenant_isolation ON "ApiClient"
  USING (
        current_setting('app.organization_id', true) = '*'
        or "organizationId"::text = current_setting('app.organization_id', true)
  )
  WITH CHECK (
        current_setting('app.organization_id', true) = '*'
        or "organizationId"::text = current_setting('app.organization_id', true)
  );

-- The key table is read by the authentication path *before* a tenant exists, so
-- that lookup necessarily runs as the system tenant ('*') — the same exception
-- the user-profile lookup already needs, and for the same reason: this query is
-- what produces the tenant. Every other access to this table is a console
-- operation and is scoped normally.
ALTER TABLE "ApiClientKey" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ApiClientKey";
CREATE POLICY tenant_isolation ON "ApiClientKey"
  USING (
        current_setting('app.organization_id', true) = '*'
        or "organizationId"::text = current_setting('app.organization_id', true)
  )
  WITH CHECK (
        current_setting('app.organization_id', true) = '*'
        or "organizationId"::text = current_setting('app.organization_id', true)
  );
