-- A Xero project for each visit (2026-11-11). The office keeps one in THMP's
-- books for every visit -- "Moses: Tenant Benefit Package - 4th Qtr - 2026 -
-- 11.10.2026", deadline the visit's day -- with the technician's labour on it,
-- and puts the invoice's line on it before approving the invoice. Xero's API
-- makes the project and logs the labour as time; it cannot put an invoice
-- line on a project, so with projects on a company's invoices go to Xero as
-- drafts, for the office to choose each line's project and approve.

-- The company's choices: projects on or off; the Xero user the labour is
-- logged under; the labour's rate and minutes ($35 an hour, 6 minutes: the
-- $3.50 the office has been adding by hand).
ALTER TABLE "XeroSettings" ADD COLUMN "projectsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "XeroSettings" ADD COLUMN "projectUserId" TEXT;
ALTER TABLE "XeroSettings" ADD COLUMN "labourRateCents" INTEGER NOT NULL DEFAULT 3500;
ALTER TABLE "XeroSettings" ADD COLUMN "labourMinutes" INTEGER NOT NULL DEFAULT 6;
ALTER TABLE "XeroSettings" ADD CONSTRAINT "XeroSettings_labour_in_range"
  CHECK ("labourRateCents" BETWEEN 0 AND 100000 AND "labourMinutes" BETWEEN 0 AND 600);
-- Xero takes no payment on a draft: while invoices go as drafts, payments stay out.
ALTER TABLE "XeroSettings" ADD CONSTRAINT "XeroSettings_projects_keep_payments_out"
  CHECK (NOT "projectsEnabled" OR NOT "paymentsToXero");

-- The organisation's Xero users who can log time on projects, as last read.
ALTER TABLE "XeroOrganisation" ADD COLUMN "projectUsers" JSONB;

-- Each visit's project in one company's books: Xero's id for it, whether the
-- console made it (labour is logged only on its own) or found the office's,
-- the labour task and time entry once made -- so a run that stopped half-way
-- carries on without making anything twice -- and, when Xero refused, why and
-- when to try again.
CREATE TABLE "XeroProjectLink" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "xeroTenantId" TEXT NOT NULL,
    "inspectionId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "xeroProjectId" TEXT,
    "madeHere" BOOLEAN NOT NULL DEFAULT false,
    "xeroTaskId" TEXT,
    "xeroTimeEntryId" TEXT,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "problem" TEXT,
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroProjectLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "XeroProjectLink_organizationId_xeroTenantId_inspectionId_key" ON "XeroProjectLink"("organizationId", "xeroTenantId", "inspectionId");
CREATE INDEX "XeroProjectLink_organizationId_xeroTenantId_status_idx" ON "XeroProjectLink"("organizationId", "xeroTenantId", "status");
CREATE INDEX "XeroProjectLink_inspectionId_idx" ON "XeroProjectLink"("inspectionId");

ALTER TABLE "XeroProjectLink" ADD CONSTRAINT "XeroProjectLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "XeroProjectLink" ADD CONSTRAINT "XeroProjectLink_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "XeroProjectLink" ADD CONSTRAINT "XeroProjectLink_organizationId_xeroTenantId_fkey" FOREIGN KEY ("organizationId", "xeroTenantId") REFERENCES "XeroOrganisation"("organizationId", "xeroTenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "XeroProjectLink" ADD CONSTRAINT "XeroProjectLink_status_known" CHECK ("status" IN ('DONE', 'FAILED'));
ALTER TABLE "XeroProjectLink" ADD CONSTRAINT "XeroProjectLink_attempts_counted" CHECK ("attempts" >= 0);
-- A finished one has its project in Xero.
ALTER TABLE "XeroProjectLink" ADD CONSTRAINT "XeroProjectLink_done_has_project" CHECK ("status" <> 'DONE' OR "xeroProjectId" IS NOT NULL);
-- A time entry is logged against a task.
ALTER TABLE "XeroProjectLink" ADD CONSTRAINT "XeroProjectLink_time_has_task" CHECK ("xeroTimeEntryId" IS NULL OR "xeroTaskId" IS NOT NULL);

ALTER TABLE "XeroProjectLink" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "XeroProjectLink"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
