-- Purchasing Setup, part 5b (2026-11-21, from the approved PurchasingSetup
-- board): the roles and who holds them. A Role on the Roles page may be marked
-- as one of the eight purchasing roles; each person has the companies they act
-- for and, as an approver, their own limit; the office says whether approvers
-- approve only for their own companies; and a step may ask for an approver
-- whose own limit reaches its top.
--
-- Additive only. With no person rows, everybody acts for every company with
-- no limit of their own -- exactly as before.

-- ── A Role that is a purchasing role ───────────────────────────────────────
ALTER TABLE "Role" ADD COLUMN "purchasingRole" TEXT;
ALTER TABLE "Role" ADD CONSTRAINT "Role_purchasing_role" CHECK ("purchasingRole" IS NULL OR "purchasingRole" IN (
    'REQUISITIONER', 'PURCHASER', 'APPROVER', 'STOCK_KEEPER', 'RECEIVER', 'CODE_ADMIN', 'BILL_PAYER', 'PURCHASING_ADMIN'
));
-- One Role an office for each purchasing role.
CREATE UNIQUE INDEX "Role_organizationId_purchasingRole_key" ON "Role"("organizationId", "purchasingRole") WHERE "purchasingRole" IS NOT NULL;

-- ── Each person's companies and approver limit ───────────────────────────────
CREATE TABLE "PurchasingPerson" (
    "organizationId" UUID NOT NULL,
    "userProfileId" UUID NOT NULL,
    -- The Xero tenants they act for; empty is every company.
    "companyTenantIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "approvesAnyAmount" BOOLEAN NOT NULL DEFAULT false,
    -- Never approves above this; NULL for no limit of their own.
    "approvalLimitCents" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchasingPerson_pkey" PRIMARY KEY ("organizationId", "userProfileId"),
    CONSTRAINT "PurchasingPerson_limit" CHECK ("approvalLimitCents" IS NULL OR "approvalLimitCents" > 0),
    -- Any amount, or a limit: never both.
    CONSTRAINT "PurchasingPerson_any_or_limit" CHECK (NOT ("approvesAnyAmount" AND "approvalLimitCents" IS NOT NULL)),
    CONSTRAINT "PurchasingPerson_companies" CHECK (cardinality("companyTenantIds") <= 20)
);

ALTER TABLE "PurchasingPerson" ADD CONSTRAINT "PurchasingPerson_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchasingPerson" ADD CONSTRAINT "PurchasingPerson_userProfileId_fkey"
    FOREIGN KEY ("userProfileId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PurchasingPerson" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PurchasingPerson"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

-- ── Approvers and their companies; a step by an approver's own limit ─────────
ALTER TABLE "PurchasingSettings" ADD COLUMN "approverOwnCompaniesOnly" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "PurchasingApprovalStep" DROP CONSTRAINT "PurchasingApprovalStep_approver";
ALTER TABLE "PurchasingApprovalStep" ADD CONSTRAINT "PurchasingApprovalStep_approver" CHECK ("approver" IN ('ANY_APPROVER', 'APPROVER_LIMIT', 'ANY_AMOUNT'));
-- The last step has no top, so no approver's limit can reach it.
ALTER TABLE "PurchasingApprovalStep" ADD CONSTRAINT "PurchasingApprovalStep_limit_has_a_top" CHECK ("approver" <> 'APPROVER_LIMIT' OR "upToCents" IS NOT NULL);
