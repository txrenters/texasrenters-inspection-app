-- Purchasing Setup, part 5a (2026-11-20, from the approved PurchasingSetup
-- board): the office's approval steps by amount, its document numbers' prefix
-- and digits, its rules for files on a requisition, and when the approvers of
-- a waiting requisition were asked and reminded.
--
-- Additive only. With no steps saved, the office's existing limit and quotes
-- read as two steps, exactly as before; with no prefix or digits on a series,
-- its numbers are written as before.

-- ── Approval steps ────────────────────────────────────────────────────────
CREATE TABLE "PurchasingApprovalStep" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    -- The step's top, inclusive; NULL on the last, which takes every larger amount.
    "upToCents" INTEGER,
    "approver" TEXT NOT NULL,
    "quotesNeeded" INTEGER NOT NULL DEFAULT 0,
    "reminderDays" INTEGER,

    CONSTRAINT "PurchasingApprovalStep_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchasingApprovalStep_position" CHECK ("position" BETWEEN 0 AND 5),
    CONSTRAINT "PurchasingApprovalStep_up_to" CHECK ("upToCents" IS NULL OR "upToCents" > 0),
    CONSTRAINT "PurchasingApprovalStep_approver" CHECK ("approver" IN ('ANY_APPROVER', 'ANY_AMOUNT')),
    CONSTRAINT "PurchasingApprovalStep_quotes" CHECK ("quotesNeeded" BETWEEN 0 AND 10),
    CONSTRAINT "PurchasingApprovalStep_reminder" CHECK ("reminderDays" IS NULL OR "reminderDays" BETWEEN 1 AND 14)
);

CREATE UNIQUE INDEX "PurchasingApprovalStep_organizationId_position_key" ON "PurchasingApprovalStep"("organizationId", "position");
-- One step a top, and one step without one.
CREATE UNIQUE INDEX "PurchasingApprovalStep_one_step_a_top" ON "PurchasingApprovalStep"("organizationId", "upToCents") NULLS NOT DISTINCT;

ALTER TABLE "PurchasingApprovalStep" ADD CONSTRAINT "PurchasingApprovalStep_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PurchasingApprovalStep" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PurchasingApprovalStep"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

-- ── The office's switches and file rules ────────────────────────────────────
-- Emails to approvers start off: the office switches them on in Setup.
ALTER TABLE "PurchasingSettings"
    ADD COLUMN "emailApprovers" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "reapproveChangedOrders" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "fileGroups" TEXT[] NOT NULL DEFAULT ARRAY['PDF', 'PICTURES', 'WORD', 'EXCEL']::TEXT[],
    ADD COLUMN "fileMaxBytes" INTEGER NOT NULL DEFAULT 20000000,
    ADD COLUMN "filesMax" INTEGER NOT NULL DEFAULT 20,
    ADD COLUMN "quoteFileAboveCents" INTEGER,
    ADD COLUMN "fileRemoval" TEXT NOT NULL DEFAULT 'UNTIL_SENT';

ALTER TABLE "PurchasingSettings"
    ADD CONSTRAINT "PurchasingSettings_file_groups" CHECK (cardinality("fileGroups") >= 1 AND "fileGroups" <@ ARRAY['PDF', 'PICTURES', 'WORD', 'EXCEL']::TEXT[]),
    -- The server takes at most 20 MB in one upload.
    ADD CONSTRAINT "PurchasingSettings_file_max_bytes" CHECK ("fileMaxBytes" IN (5000000, 10000000, 20000000)),
    ADD CONSTRAINT "PurchasingSettings_files_max" CHECK ("filesMax" BETWEEN 1 AND 50),
    ADD CONSTRAINT "PurchasingSettings_quote_file_above" CHECK ("quoteFileAboveCents" IS NULL OR "quoteFileAboveCents" >= 0),
    ADD CONSTRAINT "PurchasingSettings_file_removal" CHECK ("fileRemoval" IN ('UNTIL_SENT', 'UNTIL_ORDERED'));

-- ── Document numbers ───────────────────────────────────────────────────────
-- NULL keeps what the console wrote before Setup (PR- and five digits, PO- and four, ...).
ALTER TABLE "DocumentSeries"
    ADD COLUMN "prefix" TEXT,
    ADD COLUMN "digits" INTEGER;

ALTER TABLE "DocumentSeries"
    ADD CONSTRAINT "DocumentSeries_prefix" CHECK ("prefix" IS NULL OR "prefix" ~ '^[A-Z0-9][A-Z0-9-]{0,7}$'),
    ADD CONSTRAINT "DocumentSeries_digits" CHECK ("digits" IS NULL OR "digits" BETWEEN 3 AND 8);

-- ── Asking and reminding the approvers ──────────────────────────────────────
-- When it was last sent for approval, and when its approvers were reminded: once.
ALTER TABLE "PurchaseRequisition"
    ADD COLUMN "approvalRequestedAt" TIMESTAMP(3),
    ADD COLUMN "approvalRemindedAt" TIMESTAMP(3);

UPDATE "PurchaseRequisition" SET "approvalRequestedAt" = "submittedAt" WHERE "status" = 'SUBMITTED';

CREATE INDEX "PurchaseRequisition_waiting_for_a_reminder_idx" ON "PurchaseRequisition"("organizationId", "approvalRequestedAt")
    WHERE "status" = 'SUBMITTED' AND "approvalRemindedAt" IS NULL;
