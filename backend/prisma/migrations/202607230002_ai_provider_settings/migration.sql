CREATE TYPE "AiProvider" AS ENUM ('ANTHROPIC', 'OPENAI');
CREATE TYPE "AiCredentialStatus" AS ENUM ('UNVERIFIED', 'VALID', 'INVALID');

CREATE TABLE "OrganizationAiSettings" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "activeProvider" "AiProvider" NOT NULL DEFAULT 'ANTHROPIC',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrganizationAiSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiProviderConfiguration" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "provider" "AiProvider" NOT NULL,
  "modelId" TEXT NOT NULL,
  "encryptedApiKey" TEXT,
  "credentialStatus" "AiCredentialStatus" NOT NULL DEFAULT 'UNVERIFIED',
  "lastValidatedAt" TIMESTAMP(3),
  "monthlyTokenBudget" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiProviderConfiguration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiUsageEvent" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "provider" "AiProvider" NOT NULL,
  "modelId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "sourceId" UUID,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "totalTokens" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiUsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationAiSettings_organizationId_key" ON "OrganizationAiSettings"("organizationId");
CREATE UNIQUE INDEX "AiProviderConfiguration_organizationId_provider_key" ON "AiProviderConfiguration"("organizationId", "provider");
CREATE INDEX "AiProviderConfiguration_provider_credentialStatus_idx" ON "AiProviderConfiguration"("provider", "credentialStatus");
CREATE INDEX "AiUsageEvent_organizationId_provider_createdAt_idx" ON "AiUsageEvent"("organizationId", "provider", "createdAt");
CREATE INDEX "AiUsageEvent_sourceId_idx" ON "AiUsageEvent"("sourceId");

ALTER TABLE "OrganizationAiSettings" ADD CONSTRAINT "OrganizationAiSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiProviderConfiguration" ADD CONSTRAINT "AiProviderConfiguration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiUsageEvent" ADD CONSTRAINT "AiUsageEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
