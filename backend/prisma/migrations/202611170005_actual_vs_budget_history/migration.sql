-- Actual vs Budget's history (2026-11-17, PR 4): past technicians' logs as
-- the office's workbook kept them -- its hidden technician tabs -- read from
-- the workbook the office uploads, kept to read. Nothing is worked out from it.

CREATE TABLE "RevenueHistorySheet" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "headers" JSONB NOT NULL,
    "rows" JSONB NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedById" UUID,

    CONSTRAINT "RevenueHistorySheet_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RevenueHistorySheet_row_count" CHECK ("rowCount" BETWEEN 0 AND 20000)
);
CREATE UNIQUE INDEX "RevenueHistorySheet_organizationId_name_key" ON "RevenueHistorySheet"("organizationId", "name");
ALTER TABLE "RevenueHistorySheet" ADD CONSTRAINT "RevenueHistorySheet_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RevenueHistorySheet" ADD CONSTRAINT "RevenueHistorySheet_importedById_fkey" FOREIGN KEY ("importedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RevenueHistorySheet" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "RevenueHistorySheet"
  USING (current_setting('app.organization_id', true) = '*' OR "organizationId"::text = current_setting('app.organization_id', true));
