-- Automatic, geofenced time tracking: the tables the segment engine writes.
--
-- Replaces Start job / End job as the source of billable time. Measured against
-- a month of real jobs on 2026-09-23, the manual buttons were wrong in both
-- directions -- one visit recorded 43.9 hours because End job was never
-- pressed, others recorded seven minutes for visits the trail shows ran two
-- hours -- which is what this exists to stop.
--
-- Additive only. Nothing here alters or drops an existing table, so the release
-- that carries it changes no behaviour until the engine is switched on.

-- CreateEnum
CREATE TYPE "TimeSegmentCategory" AS ENUM ('ONSITE', 'DRIVING', 'GENERAL');

-- CreateEnum
CREATE TYPE "TimeSegmentSource" AS ENUM ('AUTOMATIC', 'MANUAL');

-- CreateTable: what counts as being at a property, per property.
-- Separate from the building's own coordinates, which say where the roof is;
-- these say how close a technician must be for the time to be billed. A
-- property with no row uses the defaults.
CREATE TABLE "PropertyGeofence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "buildingId" UUID NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "enterRadiusMeters" INTEGER NOT NULL DEFAULT 40,
    "exitRadiusMeters" INTEGER NOT NULL DEFAULT 60,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyGeofence_pkey" PRIMARY KEY ("id")
);

-- CreateTable: a stretch of a technician's day, as the trail accounts for it.
-- Derived, never typed: recomputed from the raw fixes whenever the rule or a
-- property's pin changes, which is what lets a corrected pin fix last week's
-- invoice rather than only next week's.
CREATE TABLE "TimeSegment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "technicianId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "category" "TimeSegmentCategory" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "source" "TimeSegmentSource" NOT NULL DEFAULT 'AUTOMATIC',
    "adjustedAt" TIMESTAMP(3),
    "flag" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable: an administrator overruling the trail, and why.
-- The previous value is kept here rather than overwritten there, because the
-- point of the tracker is that the number is not somebody's recollection.
CREATE TABLE "TimeAdjustment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "segmentId" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "beforeStartedAt" TIMESTAMP(3) NOT NULL,
    "beforeEndedAt" TIMESTAMP(3) NOT NULL,
    "beforeDurationSeconds" INTEGER NOT NULL,
    "afterStartedAt" TIMESTAMP(3) NOT NULL,
    "afterEndedAt" TIMESTAMP(3) NOT NULL,
    "afterDurationSeconds" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable: a stretch the trail cannot account for.
-- So that a phone which died, was left in a van or was killed by a power
-- manager produces a question for a person rather than an unpaid technician.
CREATE TABLE "TrackingGap" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "technicianId" UUID NOT NULL,
    "inspectionId" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" UUID,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingGap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PropertyGeofence_buildingId_key" ON "PropertyGeofence"("buildingId");
CREATE INDEX "PropertyGeofence_organizationId_idx" ON "PropertyGeofence"("organizationId");
CREATE INDEX "TimeSegment_organizationId_technicianId_startedAt_idx" ON "TimeSegment"("organizationId", "technicianId", "startedAt");
CREATE INDEX "TimeSegment_inspectionId_category_idx" ON "TimeSegment"("inspectionId", "category");
CREATE INDEX "TimeAdjustment_organizationId_createdAt_idx" ON "TimeAdjustment"("organizationId", "createdAt");
CREATE INDEX "TrackingGap_organizationId_resolvedAt_startedAt_idx" ON "TrackingGap"("organizationId", "resolvedAt", "startedAt");

-- AddForeignKey
ALTER TABLE "PropertyGeofence" ADD CONSTRAINT "PropertyGeofence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PropertyGeofence" ADD CONSTRAINT "PropertyGeofence_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "propertyware_buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PropertyGeofence" ADD CONSTRAINT "PropertyGeofence_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TimeSegment" ADD CONSTRAINT "TimeSegment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimeSegment" ADD CONSTRAINT "TimeSegment_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimeSegment" ADD CONSTRAINT "TimeSegment_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TimeAdjustment" ADD CONSTRAINT "TimeAdjustment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimeAdjustment" ADD CONSTRAINT "TimeAdjustment_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "TimeSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimeAdjustment" ADD CONSTRAINT "TimeAdjustment_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TrackingGap" ADD CONSTRAINT "TrackingGap_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrackingGap" ADD CONSTRAINT "TrackingGap_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrackingGap" ADD CONSTRAINT "TrackingGap_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TrackingGap" ADD CONSTRAINT "TrackingGap_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant isolation.
--
-- Every one of these carries `organizationId` directly, so each is a "direct"
-- table in the terms `generate-rls-policies.mjs` uses. Written here rather than
-- left to that script's next run because a missing policy is invisible: the
-- table simply stays readable by everyone, and nothing fails to tell you.
ALTER TABLE "PropertyGeofence" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "PropertyGeofence"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "TimeSegment" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "TimeSegment"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "TimeAdjustment" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "TimeAdjustment"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "TrackingGap" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "TrackingGap"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
