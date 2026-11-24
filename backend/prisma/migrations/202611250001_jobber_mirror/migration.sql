-- A read-only copy of every Jobber record, kept until and after Jobber is
-- removed (2026-11-24).

CREATE TYPE "JobberRecordKind" AS ENUM ('CLIENT', 'PROPERTY', 'JOB', 'VISIT', 'QUOTE', 'REQUEST');

CREATE TABLE "JobberRecord" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "kind" "JobberRecordKind" NOT NULL,
  "jobberId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "number" TEXT,
  "title" TEXT,
  "clientJobberId" TEXT,
  "propertyJobberId" TEXT,
  "jobJobberId" TEXT,
  "address" TEXT,
  "occursAt" TIMESTAMP(3),
  "status" TEXT,
  "jobberCreatedAt" TIMESTAMP(3),
  "jobberUpdatedAt" TIMESTAMP(3),
  "extractFailed" BOOLEAN NOT NULL DEFAULT false,
  "fileCount" INTEGER NOT NULL DEFAULT 0,
  "filesListedAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "deletedInJobberAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JobberRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobberRecord_organizationId_kind_jobberId_key" ON "JobberRecord"("organizationId", "kind", "jobberId");
CREATE INDEX "JobberRecord_organizationId_kind_occursAt_idx" ON "JobberRecord"("organizationId", "kind", "occursAt");
CREATE INDEX "JobberRecord_organizationId_kind_number_idx" ON "JobberRecord"("organizationId", "kind", "number");
CREATE INDEX "JobberRecord_organizationId_clientJobberId_idx" ON "JobberRecord"("organizationId", "clientJobberId");
CREATE INDEX "JobberRecord_organizationId_jobJobberId_idx" ON "JobberRecord"("organizationId", "jobJobberId");
CREATE INDEX "JobberRecord_organizationId_kind_lastSeenAt_idx" ON "JobberRecord"("organizationId", "kind", "lastSeenAt");

ALTER TABLE "JobberRecord" ADD CONSTRAINT "JobberRecord_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "JobberRecordFile" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "recordId" UUID NOT NULL,
  "jobberFileId" TEXT NOT NULL,
  "fileName" TEXT,
  "contentType" TEXT,
  "sizeBytes" INTEGER,
  "storageKey" TEXT,
  "copyAttempts" INTEGER NOT NULL DEFAULT 0,
  "copyAttemptedAt" TIMESTAMP(3),
  "copyProblem" TEXT,
  "copiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JobberRecordFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobberRecordFile_organizationId_jobberFileId_key" ON "JobberRecordFile"("organizationId", "jobberFileId");
CREATE INDEX "JobberRecordFile_recordId_idx" ON "JobberRecordFile"("recordId");
CREATE INDEX "JobberRecordFile_organizationId_storageKey_idx" ON "JobberRecordFile"("organizationId", "storageKey");

ALTER TABLE "JobberRecordFile" ADD CONSTRAINT "JobberRecordFile_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobberRecordFile" ADD CONSTRAINT "JobberRecordFile_recordId_fkey"
  FOREIGN KEY ("recordId") REFERENCES "JobberRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "JobberMirrorCursor" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "kind" "JobberRecordKind" NOT NULL,
  "walkCursor" TEXT,
  "walkStartedAt" TIMESTAMP(3),
  "walkCompletedAt" TIMESTAMP(3),
  "walkSeen" INTEGER NOT NULL DEFAULT 0,
  "changesCursor" TEXT,
  "changesStartedAt" TIMESTAMP(3),
  "changesCompletedAt" TIMESTAMP(3),
  "changesSince" TIMESTAMP(3),
  "lastCheckedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "lastErrorAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JobberMirrorCursor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobberMirrorCursor_organizationId_kind_key" ON "JobberMirrorCursor"("organizationId", "kind");

ALTER TABLE "JobberMirrorCursor" ADD CONSTRAINT "JobberMirrorCursor_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JobberRecord" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "JobberRecord"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "JobberRecordFile" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "JobberRecordFile"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "JobberMirrorCursor" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "JobberMirrorCursor"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
