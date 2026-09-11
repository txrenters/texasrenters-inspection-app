-- What a technician is qualified to do.
--
-- Until now the only thing this system knew about a technician was that the
-- account was active and carried the INSPECTION_TECHNICIAN role. Every
-- assignment was made by a person who knows the field staff, and none of that
-- knowledge existed anywhere a scheduler could read.
--
-- `expiresAt` is DATE, deliberately, to match `Inspection.scheduledAt`.
-- Qualification is evaluated against the day of the visit, never against now:
-- planning a quarter three months ahead means a certificate lapsing in week
-- six has to disqualify week seven onward, and a boolean cannot say that.
--
-- Grants are revoked rather than deleted so a plan published months earlier
-- can still explain why it chose the person it chose. ON DELETE CASCADE on the
-- holder, because a deleted person holds nothing -- but SET NULL on the two
-- actor columns, because who granted a skill is history and losing the grantor
-- must not lose the grant.
--
-- The two `InspectionTypeSkillRequirement` index names below are truncated at
-- `inspectionTyp`. That is Prisma's own 63-character truncation, not a typo;
-- writing the untruncated name here would leave the database and the schema
-- permanently out of step with each other.

-- CreateEnum
CREATE TYPE "SkillRequirementLevel" AS ENUM ('REQUIRED', 'PREFERRED');

-- CreateTable
CREATE TABLE "TechnicianSkill" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TechnicianSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechnicianSkillGrant" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "technicianId" UUID NOT NULL,
    "skillId" UUID NOT NULL,
    "grantedById" UUID,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATE,
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TechnicianSkillGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionTypeSkillRequirement" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "inspectionType" "InspectionType" NOT NULL,
    "skillId" UUID NOT NULL,
    "requirement" "SkillRequirementLevel" NOT NULL DEFAULT 'REQUIRED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionTypeSkillRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TechnicianSkill_organizationId_isActive_idx" ON "TechnicianSkill"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "TechnicianSkill_organizationId_key_key" ON "TechnicianSkill"("organizationId", "key");

-- CreateIndex
CREATE INDEX "TechnicianSkillGrant_organizationId_skillId_expiresAt_idx" ON "TechnicianSkillGrant"("organizationId", "skillId", "expiresAt");

-- CreateIndex
CREATE INDEX "TechnicianSkillGrant_technicianId_revokedAt_idx" ON "TechnicianSkillGrant"("technicianId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TechnicianSkillGrant_organizationId_technicianId_skillId_key" ON "TechnicianSkillGrant"("organizationId", "technicianId", "skillId");

-- CreateIndex
CREATE INDEX "InspectionTypeSkillRequirement_organizationId_inspectionTyp_idx" ON "InspectionTypeSkillRequirement"("organizationId", "inspectionType");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionTypeSkillRequirement_organizationId_inspectionTyp_key" ON "InspectionTypeSkillRequirement"("organizationId", "inspectionType", "skillId");

-- AddForeignKey
ALTER TABLE "TechnicianSkill" ADD CONSTRAINT "TechnicianSkill_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicianSkillGrant" ADD CONSTRAINT "TechnicianSkillGrant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicianSkillGrant" ADD CONSTRAINT "TechnicianSkillGrant_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicianSkillGrant" ADD CONSTRAINT "TechnicianSkillGrant_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "TechnicianSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicianSkillGrant" ADD CONSTRAINT "TechnicianSkillGrant_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicianSkillGrant" ADD CONSTRAINT "TechnicianSkillGrant_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionTypeSkillRequirement" ADD CONSTRAINT "InspectionTypeSkillRequirement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionTypeSkillRequirement" ADD CONSTRAINT "InspectionTypeSkillRequirement_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "TechnicianSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant isolation. Without a policy these tables stay readable across
-- organizations, and a missing policy is invisible -- nothing errors, the rows
-- are simply there for the wrong reader.
--
-- The `'*'` escape is what lets a maintenance script on the owner connection
-- see across organizations.
ALTER TABLE "TechnicianSkill" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "TechnicianSkill"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "TechnicianSkillGrant" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "TechnicianSkillGrant"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "InspectionTypeSkillRequirement" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "InspectionTypeSkillRequirement"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
