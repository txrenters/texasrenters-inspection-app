-- Group templates: the office's own grouping of the benefit-package properties
-- into days, made by hand in the console's Group maker (2026-09-30), and a
-- quarter's choice to lay its days out from one.
--
-- Keyed on buildings rather than tenancies: the nightly sync recreates a
-- tenancy's row and its id changes with every lease, while a building is the
-- same place every quarter.
--
-- Additive only. Every existing plan keeps a null template, which is the
-- planner's own grouping -- the behaviour it already had.

-- CreateTable
CREATE TABLE "TbpGroupTemplate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "minutesPerProperty" INTEGER NOT NULL DEFAULT 30,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TbpGroupTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TbpGroupTemplateGroup" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "target" INTEGER NOT NULL,

    CONSTRAINT "TbpGroupTemplateGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TbpGroupTemplateMember" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "buildingId" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "TbpGroupTemplateMember_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "TbpQuarterPlan"
  ADD COLUMN "groupTemplateId" UUID,
  ADD COLUMN "groupTemplateRevision" INTEGER;

-- CreateIndex
CREATE INDEX "TbpGroupTemplate_organizationId_archivedAt_idx" ON "TbpGroupTemplate"("organizationId", "archivedAt");
CREATE UNIQUE INDEX "TbpGroupTemplateGroup_templateId_position_key" ON "TbpGroupTemplateGroup"("templateId", "position");
CREATE INDEX "TbpGroupTemplateGroup_organizationId_idx" ON "TbpGroupTemplateGroup"("organizationId");
CREATE UNIQUE INDEX "TbpGroupTemplateMember_templateId_buildingId_key" ON "TbpGroupTemplateMember"("templateId", "buildingId");
CREATE UNIQUE INDEX "TbpGroupTemplateMember_groupId_position_key" ON "TbpGroupTemplateMember"("groupId", "position");
CREATE INDEX "TbpGroupTemplateMember_organizationId_idx" ON "TbpGroupTemplateMember"("organizationId");
CREATE INDEX "TbpGroupTemplateMember_buildingId_idx" ON "TbpGroupTemplateMember"("buildingId");

-- At most one active template per organization: the one the daily planner
-- builds a new quarter from. Partial, so any number may be inactive. Prisma's
-- schema cannot express this; the service sets it in one transaction as well.
CREATE UNIQUE INDEX "TbpGroupTemplate_one_active_per_organization" ON "TbpGroupTemplate"("organizationId") WHERE "isActive";

-- AddForeignKey
ALTER TABLE "TbpGroupTemplate" ADD CONSTRAINT "TbpGroupTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TbpGroupTemplate" ADD CONSTRAINT "TbpGroupTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TbpGroupTemplate" ADD CONSTRAINT "TbpGroupTemplate_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TbpGroupTemplateGroup" ADD CONSTRAINT "TbpGroupTemplateGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TbpGroupTemplateGroup" ADD CONSTRAINT "TbpGroupTemplateGroup_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "TbpGroupTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TbpGroupTemplateMember" ADD CONSTRAINT "TbpGroupTemplateMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TbpGroupTemplateMember" ADD CONSTRAINT "TbpGroupTemplateMember_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "TbpGroupTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TbpGroupTemplateMember" ADD CONSTRAINT "TbpGroupTemplateMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TbpGroupTemplateGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TbpGroupTemplateMember" ADD CONSTRAINT "TbpGroupTemplateMember_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "propertyware_buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TbpQuarterPlan" ADD CONSTRAINT "TbpQuarterPlan_groupTemplateId_fkey" FOREIGN KEY ("groupTemplateId") REFERENCES "TbpGroupTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant isolation.
--
-- Every one of these carries `organizationId` directly, so each is a "direct"
-- table in the terms `generate-rls-policies.mjs` uses. Written here rather than
-- left to that script's next run because a missing policy is invisible: the
-- table simply stays readable by everyone, and nothing fails to tell you.
ALTER TABLE "TbpGroupTemplate" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "TbpGroupTemplate"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "TbpGroupTemplateGroup" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "TbpGroupTemplateGroup"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "TbpGroupTemplateMember" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "TbpGroupTemplateMember"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
