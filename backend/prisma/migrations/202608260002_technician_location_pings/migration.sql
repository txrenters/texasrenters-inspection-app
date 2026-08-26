-- One position report from a technician's handset.
--
-- Append-only and high volume: a phone on shift produces one of these every
-- minute or two, so nothing is ever updated here and the table is pruned on a
-- schedule rather than kept indefinitely.
CREATE TABLE "TechnicianLocationPing" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "technicianId" UUID NOT NULL,
    -- DECIMAL(9,6), not the DECIMAL(6,5) the floor-plan markers use. That type
    -- holds a single integer digit, so a longitude of -97.7431 would not fit in
    -- it at all. Six decimal places is roughly 11cm.
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "accuracyMeters" INTEGER,
    "batteryPercent" INTEGER,
    -- When the handset took the fix, as distinct from when the API heard about
    -- it. A point captured with no signal arrives whenever signal returns.
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TechnicianLocationPing_pkey" PRIMARY KEY ("id")
);

-- One technician's trail, in order.
CREATE INDEX "TechnicianLocationPing_technicianId_recordedAt_idx" ON "TechnicianLocationPing"("technicianId", "recordedAt");
-- Everyone's latest position, for the map.
CREATE INDEX "TechnicianLocationPing_organizationId_recordedAt_idx" ON "TechnicianLocationPing"("organizationId", "recordedAt");

ALTER TABLE "TechnicianLocationPing" ADD CONSTRAINT "TechnicianLocationPing_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TechnicianLocationPing" ADD CONSTRAINT "TechnicianLocationPing_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant isolation, matching every other table that carries an organizationId.
-- This one holds where a named employee was at a given minute, so an escape
-- across organizations would be the most sensitive leak in the schema.
ALTER TABLE "TechnicianLocationPing" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TechnicianLocationPing";
CREATE POLICY tenant_isolation ON "TechnicianLocationPing"
  USING (
        current_setting('app.organization_id', true) = '*'
        or "organizationId"::text = current_setting('app.organization_id', true)
  )
  WITH CHECK (
        current_setting('app.organization_id', true) = '*'
        or "organizationId"::text = current_setting('app.organization_id', true)
  );
