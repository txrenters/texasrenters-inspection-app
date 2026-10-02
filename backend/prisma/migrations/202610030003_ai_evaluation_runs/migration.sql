-- The office measures a change to the AI before it ships (2026-10-03): the
-- analysis is run on recordings the office already decided, and scored against
-- those decisions -- found, missed, false alarms repeated, and whether the
-- moment it cites is the one a reviewer confirmed. One row per run, kept so
-- runs can be compared.
--
-- Additive only: a new enum and a new table.

-- CreateEnum
CREATE TYPE "AiEvaluationStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "AiEvaluationRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "status" "AiEvaluationStatus" NOT NULL DEFAULT 'RUNNING',
    "guidanceVersion" INTEGER,
    "houseRules" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "modelId" TEXT,
    "recordingCount" INTEGER NOT NULL,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "totals" JSONB,
    "results" JSONB,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedById" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiEvaluationRun_pkey" PRIMARY KEY ("id"),
    -- The same bound as the saved rules: a run tries rules that could be saved.
    CONSTRAINT "AiEvaluationRun_houseRules_check" CHECK (char_length("houseRules") <= 8000),
    CONSTRAINT "AiEvaluationRun_counts_check" CHECK (
      "recordingCount" > 0 AND "completedCount" >= 0 AND "completedCount" <= "recordingCount" AND "tokens" >= 0
    )
);

-- CreateIndex
CREATE INDEX "AiEvaluationRun_organizationId_startedAt_idx" ON "AiEvaluationRun"("organizationId", "startedAt");

-- AddForeignKey
ALTER TABLE "AiEvaluationRun" ADD CONSTRAINT "AiEvaluationRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, as for every table carrying `organizationId` directly.
ALTER TABLE "AiEvaluationRun" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "AiEvaluationRun"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
