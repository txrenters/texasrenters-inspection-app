-- The console's own copy of each file on an invoice in Jobber (2026-11-06,
-- phase 7 of taking invoicing over from Jobber). Jobber's links stop working
-- when the office leaves it, so each file is downloaded once and kept in the
-- console's private storage (`storageKey`, which phase 1 left for this). The
-- copy is retried a few times with growing waits, and what went wrong is kept
-- so the office can see it before the cutover. Additive.

ALTER TABLE "InvoiceFile" ADD COLUMN "copiedAt" TIMESTAMP(3);
ALTER TABLE "InvoiceFile" ADD COLUMN "copyAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InvoiceFile" ADD COLUMN "copyAttemptedAt" TIMESTAMP(3);
ALTER TABLE "InvoiceFile" ADD COLUMN "copyProblem" TEXT;

-- The files still to copy, newest first; and the day's attempts, for the ceiling.
CREATE INDEX "InvoiceFile_organizationId_copiedAt_idx" ON "InvoiceFile"("organizationId", "copiedAt");
CREATE INDEX "InvoiceFile_organizationId_copyAttemptedAt_idx" ON "InvoiceFile"("organizationId", "copyAttemptedAt");

-- A copy is kept, and when, together; attempts are never negative.
ALTER TABLE "InvoiceFile" ADD CONSTRAINT "InvoiceFile_copy_known" CHECK (
  ("storageKey" IS NULL) = ("copiedAt" IS NULL) AND "copyAttempts" >= 0
);
