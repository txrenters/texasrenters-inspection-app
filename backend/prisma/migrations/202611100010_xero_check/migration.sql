-- Checking the console against Xero (2026-11-10, phase 5 of the multi-company
-- plan): one month of a company's invoices, as the console has them, against
-- that organisation's books in Xero. Run only when somebody asks; the latest
-- check of each month is kept, so the page shows it without asking Xero again.
CREATE TABLE "XeroCheck" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "xeroTenantId" TEXT NOT NULL,
    -- YYYY-MM, a Texas month of invoice days.
    "month" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL,
    "ranById" UUID,
    -- What was compared and what differed: counts, and at most 200 differences in words.
    "counts" JSONB NOT NULL,
    "differences" JSONB NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroCheck_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "XeroCheck_organizationId_xeroTenantId_month_key" ON "XeroCheck"("organizationId", "xeroTenantId", "month");

ALTER TABLE "XeroCheck" ADD CONSTRAINT "XeroCheck_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "XeroCheck" ADD CONSTRAINT "XeroCheck_organizationId_xeroTenantId_fkey"
  FOREIGN KEY ("organizationId", "xeroTenantId") REFERENCES "XeroOrganisation"("organizationId", "xeroTenantId")
  ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "XeroCheck" ADD CONSTRAINT "XeroCheck_ranById_fkey" FOREIGN KEY ("ranById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "XeroCheck" ADD CONSTRAINT "XeroCheck_month_shape" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "XeroCheck" ADD CONSTRAINT "XeroCheck_calls_counted" CHECK ("calls" >= 0);

ALTER TABLE "XeroCheck" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "XeroCheck"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
