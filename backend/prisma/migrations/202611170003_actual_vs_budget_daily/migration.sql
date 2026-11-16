-- Actual vs Budget's daily sheets (2026-11-17, PR 2): next day's projection,
-- the daily actual vs projected report and the revenue tracker. Each
-- technician's daily budget and overtime rate, what the office typed for a
-- technician's day, and the office's payroll periods.

CREATE TABLE "RevenueTechnicianSetting" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "technicianId" UUID NOT NULL,
    "dailyBudgetCents" INTEGER NOT NULL,
    "otRateCents" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "RevenueTechnicianSetting_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RevenueTechnicianSetting_money_not_negative" CHECK ("dailyBudgetCents" >= 0 AND "otRateCents" >= 0)
);
CREATE UNIQUE INDEX "RevenueTechnicianSetting_technicianId_key" ON "RevenueTechnicianSetting"("technicianId");
CREATE INDEX "RevenueTechnicianSetting_organizationId_idx" ON "RevenueTechnicianSetting"("organizationId");
ALTER TABLE "RevenueTechnicianSetting" ADD CONSTRAINT "RevenueTechnicianSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RevenueTechnicianSetting" ADD CONSTRAINT "RevenueTechnicianSetting_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RevenueDayEntry" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "technicianId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "budgetCents" INTEGER,
    "workSeconds" INTEGER,
    "projectionRemarks" TEXT,
    "dailyRemarks" TEXT,
    "trackerRemarks" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "RevenueDayEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RevenueDayEntry_figures_in_range" CHECK (
        coalesce("budgetCents", 0) >= 0 AND coalesce("workSeconds", 0) BETWEEN 0 AND 86400
    )
);
CREATE UNIQUE INDEX "RevenueDayEntry_technicianId_day_key" ON "RevenueDayEntry"("technicianId", "day");
CREATE INDEX "RevenueDayEntry_organizationId_day_idx" ON "RevenueDayEntry"("organizationId", "day");
ALTER TABLE "RevenueDayEntry" ADD CONSTRAINT "RevenueDayEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RevenueDayEntry" ADD CONSTRAINT "RevenueDayEntry_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RevenueSettings" (
    "organizationId" UUID NOT NULL,
    "payrollPeriodStart" DATE NOT NULL,
    "payrollPeriodDays" INTEGER NOT NULL DEFAULT 14,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevenueSettings_pkey" PRIMARY KEY ("organizationId"),
    CONSTRAINT "RevenueSettings_period_length" CHECK ("payrollPeriodDays" BETWEEN 1 AND 31)
);
ALTER TABLE "RevenueSettings" ADD CONSTRAINT "RevenueSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RevenueTechnicianSetting" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "RevenueTechnicianSetting"
  USING (current_setting('app.organization_id', true) = '*' OR "organizationId"::text = current_setting('app.organization_id', true));
ALTER TABLE "RevenueDayEntry" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "RevenueDayEntry"
  USING (current_setting('app.organization_id', true) = '*' OR "organizationId"::text = current_setting('app.organization_id', true));
ALTER TABLE "RevenueSettings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "RevenueSettings"
  USING (current_setting('app.organization_id', true) = '*' OR "organizationId"::text = current_setting('app.organization_id', true));
