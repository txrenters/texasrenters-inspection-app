-- Which technicians the work-order matcher may pick. Empty means every active
-- technician, as before; once anyone is on it, only they are considered.

CREATE TABLE "WorkOrderCrewMember" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "technicianId" UUID NOT NULL,
  "addedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkOrderCrewMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkOrderCrewMember_organizationId_technicianId_key"
  ON "WorkOrderCrewMember"("organizationId", "technicianId");

ALTER TABLE "WorkOrderCrewMember" ADD CONSTRAINT "WorkOrderCrewMember_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkOrderCrewMember" ADD CONSTRAINT "WorkOrderCrewMember_technicianId_fkey"
  FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkOrderCrewMember" ADD CONSTRAINT "WorkOrderCrewMember_addedById_fkey"
  FOREIGN KEY ("addedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkOrderCrewMember" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "WorkOrderCrewMember"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
