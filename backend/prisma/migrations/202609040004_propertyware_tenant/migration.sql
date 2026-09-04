-- Tenancies as the office's own Propertyware report describes them.
--
-- `propertywareBuildingId` is nullable and ON DELETE SET NULL: a tenancy whose
-- address matched no building is still worth showing, and losing the building
-- must not lose the tenancy.
--
-- `tbpEnrollment` is text, not a boolean. Propertyware writes `Yes`, `No` and
-- `Not Verified`, and the third means "nobody has checked" — coercing it would
-- file those rows under whichever side the coercion happened to pick.

CREATE TABLE "PropertywareTenant" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "leaseName" TEXT NOT NULL,
    "sourceStatus" TEXT,
    "startDate" DATE,
    "endDate" DATE,
    "tbpEnrollment" TEXT,
    "zone" TEXT,
    "managementPlan" TEXT,
    "hvacPlan" TEXT,
    "hvacFilterLocation" TEXT,
    "hvacFilterSizes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastFilterDelivery" TEXT,
    "lastHvacInspection" DATE,
    "lastOccupiedInspection" TEXT,
    "addressLine1" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "propertywareBuildingId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "firstSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertywareTenant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PropertywareTenant_organizationId_externalId_key"
    ON "PropertywareTenant"("organizationId", "externalId");

CREATE INDEX "PropertywareTenant_organizationId_isActive_idx"
    ON "PropertywareTenant"("organizationId", "isActive");

CREATE INDEX "PropertywareTenant_organizationId_tbpEnrollment_idx"
    ON "PropertywareTenant"("organizationId", "tbpEnrollment");

CREATE INDEX "PropertywareTenant_propertywareBuildingId_idx"
    ON "PropertywareTenant"("propertywareBuildingId");

ALTER TABLE "PropertywareTenant"
    ADD CONSTRAINT "PropertywareTenant_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PropertywareTenant"
    ADD CONSTRAINT "PropertywareTenant_propertywareBuildingId_fkey"
    FOREIGN KEY ("propertywareBuildingId") REFERENCES "propertyware_buildings"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
