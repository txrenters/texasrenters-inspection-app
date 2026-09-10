-- The catalogue of Propertyware documents, and what became of each one.
--
-- Propertyware keeps every file for a property against the *building*, in one
-- undifferentiated list: leasing agreements, flood certificates, and the
-- Inspect & Cloud inspection reports the office had been importing one at a
-- time. A live survey found 12,026 documents across 577 buildings, 4,664 of
-- them named as inspections -- 683 move-ins, 473 move-outs, 1,745 occupied --
-- and weighted to the present rather than the archive: 1,442 from 2025 and
-- 1,188 from 2026.
--
-- Nothing joins a document to the inspection it documents. The REST
-- `/inspections` module is denied to this API client (403, errorCode 1001),
-- so `/docs?entityType=BUILDING` is the only way in. This table is that join.
--
-- It is also what makes the sync resumable. Discovery is one cheap request per
-- building; importing is a large download each, and one report at 7306 Cypress
-- Prairie is 81 MB. Without a record of what has already been seen, a second
-- run re-downloads the entire portfolio to discover it already has it.
CREATE TYPE "PropertywareDocumentStatus" AS ENUM (
  'DISCOVERED',
  'DOWNLOADED',
  'IMPORTED',
  'SKIPPED',
  'FAILED'
);

CREATE TABLE "PropertywareInspectionDocument" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "organizationId"     UUID NOT NULL,
  -- Propertyware's own document id, and the identity discovery is keyed on:
  -- a re-run must recognise a file it has already seen rather than fetch it.
  "externalDocumentId" TEXT NOT NULL,
  "buildingId"         UUID NOT NULL,
  "externalBuildingId" TEXT NOT NULL,
  "fileName"           TEXT NOT NULL,
  "fileType"           TEXT,
  -- When Propertyware received the file, not when the inspection happened.
  -- The report states its own date, and some were uploaded years later.
  "sourceCreatedAt"    TIMESTAMP(3),
  "guessedKind"        TEXT NOT NULL,
  "inspectionType"     "InspectionType",
  -- Deliberately not unique: the office re-uploads reports, so two documents
  -- can be byte-identical and both are real catalogue rows.
  "fingerprint"        TEXT,
  "sizeBytes"          INTEGER,
  "status"             "PropertywareDocumentStatus" NOT NULL DEFAULT 'DISCOVERED',
  "errorCode"          TEXT,
  "inspectionId"       UUID,
  "importedAt"         TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PropertywareInspectionDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PropertywareInspectionDocument_externalDocumentId_key"
  ON "PropertywareInspectionDocument" ("externalDocumentId");

CREATE INDEX "PropertywareInspectionDocument_organizationId_status_idx"
  ON "PropertywareInspectionDocument" ("organizationId", "status");

-- Named explicitly: the generated name is 64 characters and Postgres truncates
-- silently at 63, which leaves the database holding an index the schema does
-- not think exists.
CREATE INDEX "PropertywareInspectionDocument_org_inspectionType_idx"
  ON "PropertywareInspectionDocument" ("organizationId", "inspectionType");

CREATE INDEX "PropertywareInspectionDocument_buildingId_idx"
  ON "PropertywareInspectionDocument" ("buildingId");

CREATE INDEX "PropertywareInspectionDocument_organizationId_fingerprint_idx"
  ON "PropertywareInspectionDocument" ("organizationId", "fingerprint");

ALTER TABLE "PropertywareInspectionDocument"
  ADD CONSTRAINT "PropertywareInspectionDocument_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cascade, unlike the organization link. A building removed from Propertyware
-- takes its own document catalogue with it; the rows describe files that only
-- exist in the context of that building, and an orphan row would point at a
-- download that can never be resolved again.
ALTER TABLE "PropertywareInspectionDocument"
  ADD CONSTRAINT "PropertywareInspectionDocument_buildingId_fkey"
  FOREIGN KEY ("buildingId") REFERENCES "propertyware_buildings" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, the same policy every organization-scoped table carries.
--
-- `propertyware_buildings`, which this cascades from, has one; the closest
-- analogue by purpose -- `InspectionImportJob` -- does not, and that is a gap
-- rather than a precedent. A missing policy is invisible: the table simply
-- stays readable by everyone, and nothing fails to tell you.
--
-- The `'*'` escape is what lets a maintenance script on the owner connection
-- see across organizations, which is exactly how the catalogue gets populated
-- in the first place.
ALTER TABLE "PropertywareInspectionDocument" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "PropertywareInspectionDocument"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
