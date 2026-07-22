-- Homeowner-facing report share links. Each link is an unguessable token an
-- administrator creates for one inspection, optionally addressed to a
-- homeowner email, with expiry and revocation.

CREATE TABLE "InspectionReportShare" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "recipientEmail" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionReportShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InspectionReportShare_token_key" ON "InspectionReportShare"("token");
CREATE INDEX "InspectionReportShare_inspectionId_idx" ON "InspectionReportShare"("inspectionId");

ALTER TABLE "InspectionReportShare"
  ADD CONSTRAINT "InspectionReportShare_inspectionId_fkey"
  FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InspectionReportShare"
  ADD CONSTRAINT "InspectionReportShare_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
