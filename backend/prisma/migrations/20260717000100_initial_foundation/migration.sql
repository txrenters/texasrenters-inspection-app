-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SYSTEM_ADMIN', 'PROPERTY_ADMIN', 'INSPECTION_SUPERVISOR', 'INSPECTION_TECHNICIAN', 'CONDITION_REVIEWER', 'CHARGE_APPROVER', 'PROPERTY_OWNER_READ_ONLY');

-- CreateEnum
CREATE TYPE "FloorPlanStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'REVIEW_REQUIRED', 'APPROVED', 'FAILED');

-- CreateEnum
CREATE TYPE "ExtractionJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PropertyAreaStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InspectionStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'PROCESSING', 'REVIEW_REQUIRED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InspectionAreaCompletionStatus" AS ENUM ('PENDING', 'RECORDING', 'RECORDED', 'UPLOADED', 'COMPLETED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "MediaUploadStatus" AS ENUM ('PENDING', 'SESSION_CREATED', 'UPLOADING', 'UPLOADED', 'FAILED');

-- CreateEnum
CREATE TYPE "MediaProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "TranscriptionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiAnalysisStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "FindingReviewStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'EDITED', 'REJECTED', 'REINSPECTION_REQUESTED');

-- CreateEnum
CREATE TYPE "FindingType" AS ENUM ('POSSIBLE_NEW_DAMAGE', 'EXISTING_CONDITION', 'MAINTENANCE', 'NO_CHANGE');

-- CreateEnum
CREATE TYPE "ComparisonResult" AS ENUM ('EXISTING_CONDITION', 'POSSIBLE_NEW_DAMAGE', 'NO_MATERIAL_CHANGE', 'NORMAL_WEAR', 'OWNER_MAINTENANCE', 'MISSING_EVIDENCE', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ResponsibilityClassification" AS ENUM ('TENANT_REVIEW_REQUIRED', 'OWNER_REVIEW_REQUIRED', 'UNDETERMINED');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'IGNORED_DUPLICATE');

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" UUID NOT NULL,
    "authUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userProfileId" UUID NOT NULL,
    "role" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Property" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'TX',
    "postalCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyFloorPlan" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" "FloorPlanStatus" NOT NULL DEFAULT 'UPLOADED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyFloorPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorPlanExtractionJob" (
    "id" UUID NOT NULL,
    "floorPlanId" UUID NOT NULL,
    "status" "ExtractionJobStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "output" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorPlanExtractionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyFloor" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyFloor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyArea" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "floorId" UUID,
    "name" TEXT NOT NULL,
    "inspectionOrder" INTEGER NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "status" "PropertyAreaStatus" NOT NULL DEFAULT 'DRAFT',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BaselineInspection" (
    "id" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "inspectedAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BaselineInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BaselineAreaCondition" (
    "id" UUID NOT NULL,
    "baselineInspectionId" UUID NOT NULL,
    "propertyAreaId" UUID NOT NULL,
    "conditionSummary" TEXT NOT NULL,
    "knownDefects" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BaselineAreaCondition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BaselineMedia" (
    "id" UUID NOT NULL,
    "baselineAreaConditionId" UUID NOT NULL,
    "mediaType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BaselineMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inspection" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "status" "InspectionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionAssignment" (
    "id" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "technicianId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionArea" (
    "id" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "propertyAreaId" UUID NOT NULL,
    "completionStatus" "InspectionAreaCompletionStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionAreaStatusHistory" (
    "id" UUID NOT NULL,
    "inspectionAreaId" UUID NOT NULL,
    "fromStatus" "InspectionAreaCompletionStatus",
    "toStatus" "InspectionAreaCompletionStatus" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionAreaStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionMedia" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "inspectionAreaId" UUID NOT NULL,
    "technicianId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMediaId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "uploadStatus" "MediaUploadStatus" NOT NULL DEFAULT 'PENDING',
    "processingStatus" "MediaProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaUploadSession" (
    "id" UUID NOT NULL,
    "inspectionAreaId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerUploadId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaUploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaProcessingEvent" (
    "id" UUID NOT NULL,
    "inspectionMediaId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "providerEventId" TEXT,
    "payloadSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaProcessingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptionJob" (
    "id" UUID NOT NULL,
    "inspectionMediaId" UUID NOT NULL,
    "status" "TranscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "language" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranscriptionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptSegment" (
    "id" UUID NOT NULL,
    "transcriptionJobId" UUID NOT NULL,
    "startSeconds" INTEGER NOT NULL,
    "endSeconds" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAnalysisJob" (
    "id" UUID NOT NULL,
    "inspectionMediaId" UUID NOT NULL,
    "status" "AiAnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAnalysisJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionFinding" (
    "id" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "propertyAreaId" UUID NOT NULL,
    "inspectionMediaId" UUID NOT NULL,
    "aiAnalysisJobId" UUID,
    "findingType" "FindingType" NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "baselineCondition" TEXT NOT NULL,
    "comparisonResult" "ComparisonResult" NOT NULL,
    "videoTimestampStart" INTEGER NOT NULL,
    "videoTimestampEnd" INTEGER NOT NULL,
    "severity" "Severity" NOT NULL,
    "possibleResponsibility" "ResponsibilityClassification" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "recommendedReview" TEXT NOT NULL,
    "reviewStatus" "FindingReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingReview" (
    "id" UUID NOT NULL,
    "findingId" UUID NOT NULL,
    "reviewerId" UUID NOT NULL,
    "status" "FindingReviewStatus" NOT NULL,
    "reason" TEXT,
    "editedValue" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FindingReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "actorUserId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "status" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "payloadHash" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_authUserId_key" ON "UserProfile"("authUserId");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_email_key" ON "UserProfile"("email");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userProfileId_role_key" ON "OrganizationMember"("organizationId", "userProfileId", "role");

-- CreateIndex
CREATE INDEX "FloorPlanExtractionJob_status_idx" ON "FloorPlanExtractionJob"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyFloor_propertyId_name_key" ON "PropertyFloor"("propertyId", "name");

-- CreateIndex
CREATE INDEX "PropertyArea_propertyId_floorId_inspectionOrder_idx" ON "PropertyArea"("propertyId", "floorId", "inspectionOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyArea_propertyId_floorId_name_key" ON "PropertyArea"("propertyId", "floorId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "BaselineAreaCondition_baselineInspectionId_propertyAreaId_key" ON "BaselineAreaCondition"("baselineInspectionId", "propertyAreaId");

-- CreateIndex
CREATE INDEX "InspectionAssignment_technicianId_status_idx" ON "InspectionAssignment"("technicianId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionAssignment_inspectionId_technicianId_key" ON "InspectionAssignment"("inspectionId", "technicianId");

-- CreateIndex
CREATE INDEX "InspectionArea_inspectionId_idx" ON "InspectionArea"("inspectionId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionArea_inspectionId_propertyAreaId_key" ON "InspectionArea"("inspectionId", "propertyAreaId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionMedia_providerMediaId_key" ON "InspectionMedia"("providerMediaId");

-- CreateIndex
CREATE INDEX "InspectionMedia_inspectionAreaId_idx" ON "InspectionMedia"("inspectionAreaId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaUploadSession_idempotencyKey_key" ON "MediaUploadSession"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "MediaUploadSession_providerUploadId_key" ON "MediaUploadSession"("providerUploadId");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptionJob_inspectionMediaId_key" ON "TranscriptionJob"("inspectionMediaId");

-- CreateIndex
CREATE INDEX "TranscriptionJob_status_idx" ON "TranscriptionJob"("status");

-- CreateIndex
CREATE INDEX "AiAnalysisJob_status_idx" ON "AiAnalysisJob"("status");

-- CreateIndex
CREATE INDEX "InspectionFinding_inspectionId_reviewStatus_idx" ON "InspectionFinding"("inspectionId", "reviewStatus");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_providerEventId_key" ON "WebhookEvent"("provider", "providerEventId");

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userProfileId_fkey" FOREIGN KEY ("userProfileId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyFloorPlan" ADD CONSTRAINT "PropertyFloorPlan_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorPlanExtractionJob" ADD CONSTRAINT "FloorPlanExtractionJob_floorPlanId_fkey" FOREIGN KEY ("floorPlanId") REFERENCES "PropertyFloorPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyFloor" ADD CONSTRAINT "PropertyFloor_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyArea" ADD CONSTRAINT "PropertyArea_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyArea" ADD CONSTRAINT "PropertyArea_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "PropertyFloor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BaselineInspection" ADD CONSTRAINT "BaselineInspection_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BaselineAreaCondition" ADD CONSTRAINT "BaselineAreaCondition_baselineInspectionId_fkey" FOREIGN KEY ("baselineInspectionId") REFERENCES "BaselineInspection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BaselineAreaCondition" ADD CONSTRAINT "BaselineAreaCondition_propertyAreaId_fkey" FOREIGN KEY ("propertyAreaId") REFERENCES "PropertyArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BaselineMedia" ADD CONSTRAINT "BaselineMedia_baselineAreaConditionId_fkey" FOREIGN KEY ("baselineAreaConditionId") REFERENCES "BaselineAreaCondition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionAssignment" ADD CONSTRAINT "InspectionAssignment_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionAssignment" ADD CONSTRAINT "InspectionAssignment_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionArea" ADD CONSTRAINT "InspectionArea_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionArea" ADD CONSTRAINT "InspectionArea_propertyAreaId_fkey" FOREIGN KEY ("propertyAreaId") REFERENCES "PropertyArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionAreaStatusHistory" ADD CONSTRAINT "InspectionAreaStatusHistory_inspectionAreaId_fkey" FOREIGN KEY ("inspectionAreaId") REFERENCES "InspectionArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionMedia" ADD CONSTRAINT "InspectionMedia_inspectionAreaId_fkey" FOREIGN KEY ("inspectionAreaId") REFERENCES "InspectionArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionMedia" ADD CONSTRAINT "InspectionMedia_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaUploadSession" ADD CONSTRAINT "MediaUploadSession_inspectionAreaId_fkey" FOREIGN KEY ("inspectionAreaId") REFERENCES "InspectionArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaProcessingEvent" ADD CONSTRAINT "MediaProcessingEvent_inspectionMediaId_fkey" FOREIGN KEY ("inspectionMediaId") REFERENCES "InspectionMedia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptionJob" ADD CONSTRAINT "TranscriptionJob_inspectionMediaId_fkey" FOREIGN KEY ("inspectionMediaId") REFERENCES "InspectionMedia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_transcriptionJobId_fkey" FOREIGN KEY ("transcriptionJobId") REFERENCES "TranscriptionJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAnalysisJob" ADD CONSTRAINT "AiAnalysisJob_inspectionMediaId_fkey" FOREIGN KEY ("inspectionMediaId") REFERENCES "InspectionMedia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionFinding" ADD CONSTRAINT "InspectionFinding_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionFinding" ADD CONSTRAINT "InspectionFinding_propertyAreaId_fkey" FOREIGN KEY ("propertyAreaId") REFERENCES "PropertyArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionFinding" ADD CONSTRAINT "InspectionFinding_inspectionMediaId_fkey" FOREIGN KEY ("inspectionMediaId") REFERENCES "InspectionMedia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionFinding" ADD CONSTRAINT "InspectionFinding_aiAnalysisJobId_fkey" FOREIGN KEY ("aiAnalysisJobId") REFERENCES "AiAnalysisJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingReview" ADD CONSTRAINT "FindingReview_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "InspectionFinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingReview" ADD CONSTRAINT "FindingReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
