-- Actual vs Budget's weekly and monthly reports (2026-11-17, PR 3): what the
-- office typed for a technician's week -- target, actual revenue, remarks --
-- and for a technician's month -- remarks. The figures themselves are worked
-- out from the technician log and the daily budgets.

CREATE TABLE "RevenueWeekEntry" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "technicianId" UUID NOT NULL,
    "weekStart" DATE NOT NULL,
    "targetCents" INTEGER,
    "actualCents" INTEGER,
    "remarks" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "RevenueWeekEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RevenueWeekEntry_money_not_negative" CHECK (coalesce("targetCents", 0) >= 0 AND coalesce("actualCents", 0) >= 0)
);
CREATE UNIQUE INDEX "RevenueWeekEntry_technicianId_weekStart_key" ON "RevenueWeekEntry"("technicianId", "weekStart");
CREATE INDEX "RevenueWeekEntry_organizationId_weekStart_idx" ON "RevenueWeekEntry"("organizationId", "weekStart");
ALTER TABLE "RevenueWeekEntry" ADD CONSTRAINT "RevenueWeekEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RevenueWeekEntry" ADD CONSTRAINT "RevenueWeekEntry_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RevenueMonthEntry" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "technicianId" UUID NOT NULL,
    "month" DATE NOT NULL,
    "remarks" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "RevenueMonthEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RevenueMonthEntry_first_of_month" CHECK (extract(day from "month") = 1)
);
CREATE UNIQUE INDEX "RevenueMonthEntry_technicianId_month_key" ON "RevenueMonthEntry"("technicianId", "month");
CREATE INDEX "RevenueMonthEntry_organizationId_month_idx" ON "RevenueMonthEntry"("organizationId", "month");
ALTER TABLE "RevenueMonthEntry" ADD CONSTRAINT "RevenueMonthEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RevenueMonthEntry" ADD CONSTRAINT "RevenueMonthEntry_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RevenueWeekEntry" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "RevenueWeekEntry"
  USING (current_setting('app.organization_id', true) = '*' OR "organizationId"::text = current_setting('app.organization_id', true));
ALTER TABLE "RevenueMonthEntry" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "RevenueMonthEntry"
  USING (current_setting('app.organization_id', true) = '*' OR "organizationId"::text = current_setting('app.organization_id', true));
