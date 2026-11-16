-- Actual vs Budget's technician log (2026-11-17, PR 1 of rebuilding the
-- office's "THMP Scheduling Actual Vs Budget 2026.xlsx" in the console). A row
-- is a visit the console has, with what the office typed laid over it, or a
-- row the office added for work booked elsewhere. Nothing here is called from
-- anything billed.

CREATE TYPE "RevenueColumn" AS ENUM ('LABOR', 'SERVICE_CALL_FEE', 'MATERIALS');

-- Where a product's invoice lines go in the log; null is Labor Hours Income.
ALTER TABLE "InvoiceProduct" ADD COLUMN "revenueColumn" "RevenueColumn";

CREATE TABLE "RevenueLogEntry" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "technicianId" UUID NOT NULL,
    "inspectionId" UUID,
    "day" DATE NOT NULL,
    "address" TEXT,
    "workOrder" TEXT,
    "jobNumber" TEXT,
    "driveTime" TEXT,
    "timeBudgeted" TEXT,
    "estimatedBudgetCents" INTEGER,
    "arrival" TEXT,
    "leaving" TEXT,
    "workComplete" BOOLEAN,
    "rescheduleRequired" BOOLEAN,
    "rescheduleOn" DATE,
    "laborCents" INTEGER,
    "serviceCallFeeCents" INTEGER,
    "materialsCents" INTEGER,
    "invoiceNumber" TEXT,
    "postedInPw" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "RevenueLogEntry_pkey" PRIMARY KEY ("id")
);

-- One entry per visit; any number of the office's own rows.
CREATE UNIQUE INDEX "RevenueLogEntry_inspectionId_key" ON "RevenueLogEntry"("inspectionId");
CREATE INDEX "RevenueLogEntry_organizationId_technicianId_day_idx" ON "RevenueLogEntry"("organizationId", "technicianId", "day");

ALTER TABLE "RevenueLogEntry" ADD CONSTRAINT "RevenueLogEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RevenueLogEntry" ADD CONSTRAINT "RevenueLogEntry_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A visit removed later leaves the row, and everything the office typed, where it was.
ALTER TABLE "RevenueLogEntry" ADD CONSTRAINT "RevenueLogEntry_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RevenueLogEntry" ADD CONSTRAINT "RevenueLogEntry_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Times of day as the office types them, "16:49"; money never negative.
ALTER TABLE "RevenueLogEntry" ADD CONSTRAINT "RevenueLogEntry_clock_times" CHECK (
    ("arrival" IS NULL OR "arrival" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
    AND ("leaving" IS NULL OR "leaving" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
ALTER TABLE "RevenueLogEntry" ADD CONSTRAINT "RevenueLogEntry_money_not_negative" CHECK (
    coalesce("estimatedBudgetCents", 0) >= 0 AND coalesce("laborCents", 0) >= 0
    AND coalesce("serviceCallFeeCents", 0) >= 0 AND coalesce("materialsCents", 0) >= 0
);

ALTER TABLE "RevenueLogEntry" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "RevenueLogEntry"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
