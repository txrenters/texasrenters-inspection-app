-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SYSTEM_ADMIN', 'PROPERTY_ADMIN', 'INSPECTION_SUPERVISOR', 'INSPECTION_TECHNICIAN', 'CONDITION_REVIEWER', 'CHARGE_APPROVER', 'PROPERTY_OWNER_READ_ONLY');

-- CreateEnum
CREATE TYPE "FloorPlanStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'REVIEW_REQUIRED', 'APPROVED', 'FAILED');

-- CreateEnum
CREATE TYPE "ExtractionJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PropertyAreaStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AreaEnvironment" AS ENUM ('INDOOR', 'OUTDOOR', 'SEMI_OUTDOOR');

-- CreateEnum
CREATE TYPE "AreaCategory" AS ENUM ('INDOOR_ROOM', 'HALLWAY', 'STAIRWAY', 'CLOSET', 'UTILITY', 'GARAGE', 'ATTIC', 'BASEMENT', 'BALCONY', 'PATIO', 'PORCH', 'DRIVEWAY', 'YARD', 'EXTERIOR_WALL', 'ROOF', 'PERIMETER_FENCE', 'GATE', 'POOL', 'SHED', 'OTHER_OUTDOOR', 'OTHER');

-- CreateEnum
CREATE TYPE "InspectionStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'TECHNICIAN_SUBMITTED', 'PROCESSING', 'REVIEW_REQUIRED', 'UNDER_REVIEW', 'TBD', 'FOLLOW_UP_REQUIRED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InspectionType" AS ENUM ('MOVE_IN', 'OCCUPIED', 'BACK_TO_MARKET', 'MOVE_OUT', 'HVAC');

-- CreateEnum
CREATE TYPE "InspectionAreaCompletionStatus" AS ENUM ('PENDING', 'RECORDING', 'RECORDED', 'UPLOADED', 'COMPLETED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "MediaUploadStatus" AS ENUM ('PENDING', 'SESSION_CREATED', 'UPLOADING', 'UPLOADED', 'FAILED');

-- CreateEnum
CREATE TYPE "MediaProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "PhotoCaptureType" AS ENUM ('AREA_OVERVIEW', 'WALL_OVERVIEW', 'FINDING_CONTEXT', 'FINDING_CLOSE_UP', 'SUPPORTING_ANGLE', 'SCALE_REFERENCE', 'SERIAL_OR_LABEL', 'VIDEO_FRAME_SNAPSHOT', 'OTHER', 'FINDING_DETAIL', 'SUPPORTING_EVIDENCE');

-- CreateEnum
CREATE TYPE "VideoRecordingType" AS ENUM ('PRIMARY_AREA', 'ADDITIONAL_ISSUE');

-- CreateEnum
CREATE TYPE "PhotoStorageStatus" AS ENUM ('PENDING', 'UPLOADED', 'FAILED');

-- CreateEnum
CREATE TYPE "TranscriptionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiAnalysisStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('ANTHROPIC', 'OPENAI');

-- CreateEnum
CREATE TYPE "AiCredentialStatus" AS ENUM ('UNVERIFIED', 'VALID', 'INVALID');

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

-- CreateEnum
CREATE TYPE "ComparisonStatus" AS ENUM ('DRAFT', 'UNDER_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ComparisonClassification" AS ENUM ('UNCHANGED', 'IMPROVED', 'NEW_DAMAGE', 'WORSENED', 'RESOLVED', 'MISSING_BASELINE', 'MISSING_MOVE_OUT_EVIDENCE', 'NOT_COMPARABLE', 'REQUIRES_REVIEW');

-- CreateEnum
CREATE TYPE "ComparisonMatchMethod" AS ENUM ('LOCAL_AREA_ID', 'APPROVED_ALIAS', 'NORMALIZED_NAME', 'AREA_CATEGORY', 'CONFIGURED_MAPPING', 'AI_SUGGESTED', 'MANUAL', 'UNMATCHED');

-- CreateEnum
CREATE TYPE "PetReviewStatus" AS ENUM ('PENDING_REVIEW', 'UNIQUE_PET', 'DUPLICATE', 'INSUFFICIENT_EVIDENCE');

-- CreateEnum
CREATE TYPE "PetAuthorizationStatus" AS ENUM ('UNKNOWN', 'AUTHORIZED', 'UNAUTHORIZED');

-- CreateEnum
CREATE TYPE "ChargeStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ADJUSTED', 'WAIVED');

-- CreateEnum
CREATE TYPE "ChargeCalculationType" AS ENUM ('PER_UNIQUE_ENTITY', 'FLAT', 'PER_UNIT');

-- CreateEnum
CREATE TYPE "ChargeSource" AS ENUM ('AI_SUGGESTED', 'TECHNICIAN', 'SYSTEM', 'ADMINISTRATOR');

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRoleAssignment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userProfileId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationAiSettings" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "activeProvider" "AiProvider" NOT NULL DEFAULT 'ANTHROPIC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationAiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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
CREATE TABLE "MobilePushDevice" (
    "id" UUID NOT NULL,
    "userProfileId" UUID NOT NULL,
    "expoPushToken" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobilePushDevice_pkey" PRIMARY KEY ("id")
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
    "unitId" UUID,
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
    "unitId" UUID,
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
    "unitId" UUID,
    "floorId" UUID,
    "name" TEXT NOT NULL,
    "inspectionOrder" INTEGER NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "status" "PropertyAreaStatus" NOT NULL DEFAULT 'DRAFT',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "environment" "AreaEnvironment" NOT NULL DEFAULT 'INDOOR',
    "category" "AreaCategory",
    "notes" TEXT,
    "createdById" UUID,
    "archivedAt" TIMESTAMP(3),
    "markerX" DECIMAL(6,5),
    "markerY" DECIMAL(6,5),
    "markerSource" TEXT,
    "markerConfidence" DECIMAL(4,3),
    "markerUpdatedById" UUID,
    "markerUpdatedAt" TIMESTAMP(3),
    "sourceFloorPlanId" UUID,
    "sourcePageNumber" INTEGER,
    "boundingBoxX" DECIMAL(6,5),
    "boundingBoxY" DECIMAL(6,5),
    "boundingBoxWidth" DECIMAL(6,5),
    "boundingBoxHeight" DECIMAL(6,5),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaChecklistItem" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "propertyAreaId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AreaChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyAreaAlias" (
    "id" UUID NOT NULL,
    "propertyAreaId" UUID NOT NULL,
    "alias" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertyAreaAlias_pkey" PRIMARY KEY ("id")
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
    "propertyId" UUID,
    "propertywareBuildingId" UUID,
    "propertywareUnitId" UUID,
    "propertywareLeaseId" UUID,
    "inspectionType" "InspectionType" NOT NULL,
    "baselineInspectionId" UUID,
    "priority" TEXT NOT NULL DEFAULT 'STANDARD',
    "internalNotes" TEXT,
    "createdById" UUID,
    "status" "InspectionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "finalizedById" UUID,
    "completionBlockedReason" TEXT,
    "tbdReason" TEXT,
    "followUpRequired" BOOLEAN NOT NULL DEFAULT false,
    "followUpDueAt" TIMESTAMP(3),
    "followUpTasks" TEXT,
    "parentInspectionId" UUID,
    "inspectionRound" INTEGER NOT NULL DEFAULT 1,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "propertySnapshot" JSONB,
    "leaseSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "propertyware_portfolios" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL DEFAULT 'propertyware',
    "idNumber" TEXT,
    "name" TEXT NOT NULL,
    "abbreviation" TEXT,
    "sourceStatus" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sourceCreatedAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3),
    "firstSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" TIMESTAMP(3),
    "sourceHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "propertyware_portfolios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "propertyware_owners" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL DEFAULT 'propertyware',
    "displayName" TEXT NOT NULL,
    "sourceStatus" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sourceCreatedAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3),
    "firstSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" TIMESTAMP(3),
    "sourceHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "propertyware_owners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "propertyware_portfolio_owners" (
    "id" UUID NOT NULL,
    "portfolioId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "percentageOwnership" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "propertyware_portfolio_owners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "propertyware_buildings" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL DEFAULT 'propertyware',
    "portfolioId" UUID NOT NULL,
    "externalPortfolioId" TEXT NOT NULL,
    "idNumber" TEXT,
    "name" TEXT NOT NULL,
    "abbreviation" TEXT,
    "propertyType" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "sourceStatus" TEXT,
    "totalArea" INTEGER,
    "areaUnits" TEXT,
    "category" TEXT,
    "manualTotalArea" INTEGER,
    "manualAreaUnit" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sourceCreatedAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3),
    "firstSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" TIMESTAMP(3),
    "sourceHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "propertyware_buildings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "propertyware_units" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL DEFAULT 'propertyware',
    "buildingId" UUID NOT NULL,
    "portfolioId" UUID NOT NULL,
    "externalBuildingId" TEXT NOT NULL,
    "externalPortfolioId" TEXT NOT NULL,
    "idNumber" TEXT,
    "name" TEXT NOT NULL,
    "abbreviation" TEXT,
    "type" TEXT,
    "vacant" BOOLEAN,
    "publishedForRent" BOOLEAN,
    "bedrooms" INTEGER,
    "bathrooms" DOUBLE PRECISION,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "sourceStatus" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sourceCreatedAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3),
    "firstSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" TIMESTAMP(3),
    "sourceHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "propertyware_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "propertyware_leases" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL DEFAULT 'propertyware',
    "portfolioId" UUID NOT NULL,
    "buildingId" UUID NOT NULL,
    "unitId" UUID,
    "externalPortfolioId" TEXT NOT NULL,
    "externalBuildingId" TEXT NOT NULL,
    "externalUnitId" TEXT,
    "sourceFeed" TEXT NOT NULL DEFAULT 'rest',
    "idNumber" TEXT,
    "leaseName" TEXT,
    "sourceStatus" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startDate" DATE,
    "endDate" DATE,
    "moveInDate" DATE,
    "scheduledMoveOutDate" DATE,
    "moveOutDate" DATE,
    "noticeGivenDate" DATE,
    "reasonForLeaving" TEXT,
    "tenantDisplayNames" TEXT[],
    "sourceCreatedAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3),
    "firstSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" TIMESTAMP(3),
    "sourceHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "propertyware_leases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "propertyware_sync_cursors" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "lastSuccessfulCursor" TIMESTAMP(3),
    "lastAttemptedCursor" TIMESTAMP(3),
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "lastFullReconciliationAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "propertyware_sync_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "propertyware_sync_runs" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "syncType" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cursorStart" TIMESTAMP(3),
    "cursorEnd" TIMESTAMP(3),
    "recordsFetched" INTEGER NOT NULL DEFAULT 0,
    "recordsCreated" INTEGER NOT NULL DEFAULT 0,
    "recordsUpdated" INTEGER NOT NULL DEFAULT 0,
    "recordsUnchanged" INTEGER NOT NULL DEFAULT 0,
    "recordsDeactivated" INTEGER NOT NULL DEFAULT 0,
    "recordsReactivated" INTEGER NOT NULL DEFAULT 0,
    "recordsFailed" INTEGER NOT NULL DEFAULT 0,
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "propertyware_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "propertyware_sync_run_entities" (
    "id" UUID NOT NULL,
    "syncRunId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "recordsFetched" INTEGER NOT NULL DEFAULT 0,
    "recordsCreated" INTEGER NOT NULL DEFAULT 0,
    "recordsUpdated" INTEGER NOT NULL DEFAULT 0,
    "recordsUnchanged" INTEGER NOT NULL DEFAULT 0,
    "recordsDeactivated" INTEGER NOT NULL DEFAULT 0,
    "recordsReactivated" INTEGER NOT NULL DEFAULT 0,
    "recordsFailed" INTEGER NOT NULL DEFAULT 0,
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "propertyware_sync_run_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "propertyware_sync_errors" (
    "id" UUID NOT NULL,
    "syncRunId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "externalId" TEXT,
    "pageOffset" INTEGER,
    "errorCode" TEXT NOT NULL,
    "sanitizedMessage" TEXT NOT NULL,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "payloadFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "propertyware_sync_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "propertyware_sync_locks" (
    "lockKey" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "propertyware_sync_locks_pkey" PRIMARY KEY ("lockKey")
);

-- CreateTable
CREATE TABLE "InspectionAssignment" (
    "id" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "technicianId" UUID NOT NULL,
    "assignedById" UUID NOT NULL,
    "endedById" UUID,
    "supersedesId" UUID,
    "status" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "reason" TEXT,
    "idempotencyKey" TEXT,
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
    "technicianNote" TEXT,
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
    "propertyId" UUID,
    "inspectionId" UUID NOT NULL,
    "inspectionAreaId" UUID NOT NULL,
    "technicianId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMediaId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "recordingType" "VideoRecordingType" NOT NULL DEFAULT 'PRIMARY_AREA',
    "label" TEXT,
    "category" TEXT,
    "relatedFindingId" UUID,
    "captureGuidelineVersion" TEXT,
    "captureSessionId" TEXT,
    "capturePolicyVersion" TEXT,
    "captureSummary" JSONB,
    "uploadStatus" "MediaUploadStatus" NOT NULL DEFAULT 'PENDING',
    "processingStatus" "MediaProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionPhoto" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "inspectionAreaId" UUID NOT NULL,
    "findingId" UUID,
    "capturedById" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'local',
    "storageKey" TEXT NOT NULL,
    "thumbnailKey" TEXT,
    "captureType" "PhotoCaptureType" NOT NULL DEFAULT 'AREA_OVERVIEW',
    "sequenceNumber" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT,
    "notes" TEXT,
    "mimeType" TEXT NOT NULL,
    "storageStatus" "PhotoStorageStatus" NOT NULL DEFAULT 'UPLOADED',
    "width" INTEGER,
    "height" INTEGER,
    "sizeBytes" INTEGER,
    "idempotencyKey" TEXT,
    "localFileId" TEXT,
    "metadata" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionPhoto_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "InspectionComparison" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "moveOutInspectionId" UUID NOT NULL,
    "moveInInspectionId" UUID NOT NULL,
    "status" "ComparisonStatus" NOT NULL DEFAULT 'DRAFT',
    "overallCondition" "ComparisonClassification" NOT NULL DEFAULT 'REQUIRES_REVIEW',
    "version" INTEGER NOT NULL DEFAULT 1,
    "generator" TEXT NOT NULL DEFAULT 'DETERMINISTIC',
    "requiresReviewCount" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "metadata" JSONB,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionComparison_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionAreaComparison" (
    "id" UUID NOT NULL,
    "comparisonId" UUID NOT NULL,
    "moveInPropertyAreaId" UUID,
    "moveOutPropertyAreaId" UUID,
    "areaName" TEXT NOT NULL,
    "floorName" TEXT,
    "classification" "ComparisonClassification" NOT NULL,
    "matchMethod" "ComparisonMatchMethod" NOT NULL DEFAULT 'UNMATCHED',
    "matchConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "summary" TEXT,
    "originalClassification" "ComparisonClassification",
    "overriddenById" UUID,
    "overriddenAt" TIMESTAMP(3),
    "overrideReason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionAreaComparison_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChargeRule" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "calculationType" "ChargeCalculationType" NOT NULL DEFAULT 'PER_UNIQUE_ENTITY',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChargeRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PetObservation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "propertyAreaId" UUID,
    "petCandidateId" UUID,
    "temporaryLabel" TEXT NOT NULL,
    "species" TEXT NOT NULL,
    "description" TEXT,
    "characteristics" TEXT,
    "notes" TEXT,
    "photoIds" UUID[],
    "mediaIds" UUID[],
    "possibleDuplicateOfId" UUID,
    "recordedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PetObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PetCandidate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "species" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "reviewStatus" "PetReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "authorizationStatus" "PetAuthorizationStatus" NOT NULL DEFAULT 'UNKNOWN',
    "observationCount" INTEGER NOT NULL DEFAULT 0,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PetCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Charge" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "chargeCode" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "propertyAreaId" UUID,
    "findingId" UUID,
    "petCandidateId" UUID,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitAmount" DECIMAL(10,2) NOT NULL,
    "proposedAmount" DECIMAL(10,2) NOT NULL,
    "approvedAmount" DECIMAL(10,2),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "ChargeStatus" NOT NULL DEFAULT 'DRAFT',
    "source" "ChargeSource" NOT NULL DEFAULT 'SYSTEM',
    "reason" TEXT,
    "evidenceRefs" JSONB,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Charge_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "Role_organizationId_idx" ON "Role"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_organizationId_name_key" ON "Role"("organizationId", "name");

-- CreateIndex
CREATE INDEX "UserRoleAssignment_organizationId_idx" ON "UserRoleAssignment"("organizationId");

-- CreateIndex
CREATE INDEX "UserRoleAssignment_roleId_idx" ON "UserRoleAssignment"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "UserRoleAssignment_userProfileId_roleId_key" ON "UserRoleAssignment"("userProfileId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationAiSettings_organizationId_key" ON "OrganizationAiSettings"("organizationId");

-- CreateIndex
CREATE INDEX "AiProviderConfiguration_provider_credentialStatus_idx" ON "AiProviderConfiguration"("provider", "credentialStatus");

-- CreateIndex
CREATE UNIQUE INDEX "AiProviderConfiguration_organizationId_provider_key" ON "AiProviderConfiguration"("organizationId", "provider");

-- CreateIndex
CREATE INDEX "AiUsageEvent_organizationId_provider_createdAt_idx" ON "AiUsageEvent"("organizationId", "provider", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsageEvent_sourceId_idx" ON "AiUsageEvent"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_authUserId_key" ON "UserProfile"("authUserId");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_email_key" ON "UserProfile"("email");

-- CreateIndex
CREATE UNIQUE INDEX "MobilePushDevice_expoPushToken_key" ON "MobilePushDevice"("expoPushToken");

-- CreateIndex
CREATE INDEX "MobilePushDevice_userProfileId_isActive_idx" ON "MobilePushDevice"("userProfileId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userProfileId_role_key" ON "OrganizationMember"("organizationId", "userProfileId", "role");

-- CreateIndex
CREATE INDEX "PropertyFloorPlan_propertyId_unitId_idx" ON "PropertyFloorPlan"("propertyId", "unitId");

-- CreateIndex
CREATE INDEX "FloorPlanExtractionJob_status_idx" ON "FloorPlanExtractionJob"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyFloor_propertyId_unitId_name_key" ON "PropertyFloor"("propertyId", "unitId", "name");

-- CreateIndex
CREATE INDEX "PropertyArea_propertyId_unitId_floorId_inspectionOrder_idx" ON "PropertyArea"("propertyId", "unitId", "floorId", "inspectionOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyArea_propertyId_unitId_floorId_name_key" ON "PropertyArea"("propertyId", "unitId", "floorId", "name");

-- CreateIndex
CREATE INDEX "AreaChecklistItem_propertyAreaId_sortOrder_idx" ON "AreaChecklistItem"("propertyAreaId", "sortOrder");

-- CreateIndex
CREATE INDEX "AreaChecklistItem_organizationId_idx" ON "AreaChecklistItem"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "AreaChecklistItem_propertyAreaId_label_key" ON "AreaChecklistItem"("propertyAreaId", "label");

-- CreateIndex
CREATE INDEX "PropertyAreaAlias_propertyAreaId_idx" ON "PropertyAreaAlias"("propertyAreaId");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyAreaAlias_propertyAreaId_alias_key" ON "PropertyAreaAlias"("propertyAreaId", "alias");

-- CreateIndex
CREATE UNIQUE INDEX "BaselineAreaCondition_baselineInspectionId_propertyAreaId_key" ON "BaselineAreaCondition"("baselineInspectionId", "propertyAreaId");

-- CreateIndex
CREATE INDEX "Inspection_organizationId_status_scheduledAt_idx" ON "Inspection"("organizationId", "status", "scheduledAt");

-- CreateIndex
CREATE INDEX "Inspection_organizationId_scheduledAt_idx" ON "Inspection"("organizationId", "scheduledAt" DESC);

-- CreateIndex
CREATE INDEX "Inspection_propertywareBuildingId_scheduledAt_idx" ON "Inspection"("propertywareBuildingId", "scheduledAt");

-- CreateIndex
CREATE INDEX "Inspection_propertywareUnitId_scheduledAt_idx" ON "Inspection"("propertywareUnitId", "scheduledAt");

-- CreateIndex
CREATE INDEX "Inspection_baselineInspectionId_idx" ON "Inspection"("baselineInspectionId");

-- CreateIndex
CREATE INDEX "Inspection_parentInspectionId_idx" ON "Inspection"("parentInspectionId");

-- CreateIndex
CREATE INDEX "Inspection_organizationId_propertywareBuildingId_propertywa_idx" ON "Inspection"("organizationId", "propertywareBuildingId", "propertywareUnitId", "propertywareLeaseId", "inspectionType", "scheduledAt");

-- CreateIndex
CREATE INDEX "propertyware_portfolios_organizationId_isActive_name_idx" ON "propertyware_portfolios"("organizationId", "isActive", "name");

-- CreateIndex
CREATE UNIQUE INDEX "propertyware_portfolios_organizationId_sourceSystem_externa_key" ON "propertyware_portfolios"("organizationId", "sourceSystem", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "propertyware_owners_organizationId_sourceSystem_externalId_key" ON "propertyware_owners"("organizationId", "sourceSystem", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "propertyware_portfolio_owners_portfolioId_ownerId_key" ON "propertyware_portfolio_owners"("portfolioId", "ownerId");

-- CreateIndex
CREATE INDEX "propertyware_buildings_organizationId_isActive_name_idx" ON "propertyware_buildings"("organizationId", "isActive", "name");

-- CreateIndex
CREATE UNIQUE INDEX "propertyware_buildings_organizationId_sourceSystem_external_key" ON "propertyware_buildings"("organizationId", "sourceSystem", "externalId");

-- CreateIndex
CREATE INDEX "propertyware_units_organizationId_buildingId_isActive_idx" ON "propertyware_units"("organizationId", "buildingId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "propertyware_units_organizationId_sourceSystem_externalId_key" ON "propertyware_units"("organizationId", "sourceSystem", "externalId");

-- CreateIndex
CREATE INDEX "propertyware_leases_organizationId_unitId_isActive_schedule_idx" ON "propertyware_leases"("organizationId", "unitId", "isActive", "scheduledMoveOutDate");

-- CreateIndex
CREATE UNIQUE INDEX "propertyware_leases_organizationId_sourceSystem_externalId_key" ON "propertyware_leases"("organizationId", "sourceSystem", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "propertyware_sync_cursors_organizationId_entityType_key" ON "propertyware_sync_cursors"("organizationId", "entityType");

-- CreateIndex
CREATE INDEX "propertyware_sync_runs_organizationId_createdAt_idx" ON "propertyware_sync_runs"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "propertyware_sync_runs_organizationId_status_completedAt_idx" ON "propertyware_sync_runs"("organizationId", "status", "completedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "propertyware_sync_run_entities_syncRunId_entityType_key" ON "propertyware_sync_run_entities"("syncRunId", "entityType");

-- CreateIndex
CREATE INDEX "propertyware_sync_errors_syncRunId_entityType_idx" ON "propertyware_sync_errors"("syncRunId", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionAssignment_supersedesId_key" ON "InspectionAssignment"("supersedesId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionAssignment_idempotencyKey_key" ON "InspectionAssignment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "InspectionAssignment_inspectionId_isCurrent_idx" ON "InspectionAssignment"("inspectionId", "isCurrent");

-- CreateIndex
CREATE INDEX "InspectionAssignment_technicianId_isCurrent_status_idx" ON "InspectionAssignment"("technicianId", "isCurrent", "status");

-- CreateIndex
CREATE INDEX "InspectionArea_inspectionId_idx" ON "InspectionArea"("inspectionId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionArea_inspectionId_propertyAreaId_key" ON "InspectionArea"("inspectionId", "propertyAreaId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionMedia_providerMediaId_key" ON "InspectionMedia"("providerMediaId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionMedia_captureSessionId_key" ON "InspectionMedia"("captureSessionId");

-- CreateIndex
CREATE INDEX "InspectionMedia_inspectionAreaId_idx" ON "InspectionMedia"("inspectionAreaId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionPhoto_storageKey_key" ON "InspectionPhoto"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionPhoto_idempotencyKey_key" ON "InspectionPhoto"("idempotencyKey");

-- CreateIndex
CREATE INDEX "InspectionPhoto_inspectionAreaId_captureType_sequenceNumber_idx" ON "InspectionPhoto"("inspectionAreaId", "captureType", "sequenceNumber");

-- CreateIndex
CREATE INDEX "InspectionPhoto_inspectionId_idx" ON "InspectionPhoto"("inspectionId");

-- CreateIndex
CREATE INDEX "InspectionPhoto_findingId_idx" ON "InspectionPhoto"("findingId");

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
CREATE UNIQUE INDEX "InspectionReportShare_token_key" ON "InspectionReportShare"("token");

-- CreateIndex
CREATE INDEX "InspectionReportShare_inspectionId_idx" ON "InspectionReportShare"("inspectionId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionComparison_moveOutInspectionId_key" ON "InspectionComparison"("moveOutInspectionId");

-- CreateIndex
CREATE INDEX "InspectionComparison_organizationId_idx" ON "InspectionComparison"("organizationId");

-- CreateIndex
CREATE INDEX "InspectionComparison_moveInInspectionId_idx" ON "InspectionComparison"("moveInInspectionId");

-- CreateIndex
CREATE INDEX "InspectionAreaComparison_comparisonId_idx" ON "InspectionAreaComparison"("comparisonId");

-- CreateIndex
CREATE INDEX "ChargeRule_organizationId_isActive_idx" ON "ChargeRule"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ChargeRule_organizationId_code_key" ON "ChargeRule"("organizationId", "code");

-- CreateIndex
CREATE INDEX "PetObservation_inspectionId_idx" ON "PetObservation"("inspectionId");

-- CreateIndex
CREATE INDEX "PetObservation_petCandidateId_idx" ON "PetObservation"("petCandidateId");

-- CreateIndex
CREATE INDEX "PetCandidate_inspectionId_idx" ON "PetCandidate"("inspectionId");

-- CreateIndex
CREATE INDEX "Charge_inspectionId_status_idx" ON "Charge"("inspectionId", "status");

-- CreateIndex
CREATE INDEX "Charge_petCandidateId_idx" ON "Charge"("petCandidateId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_providerEventId_key" ON "WebhookEvent"("provider", "providerEventId");

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_userProfileId_fkey" FOREIGN KEY ("userProfileId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationAiSettings" ADD CONSTRAINT "OrganizationAiSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiProviderConfiguration" ADD CONSTRAINT "AiProviderConfiguration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsageEvent" ADD CONSTRAINT "AiUsageEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobilePushDevice" ADD CONSTRAINT "MobilePushDevice_userProfileId_fkey" FOREIGN KEY ("userProfileId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userProfileId_fkey" FOREIGN KEY ("userProfileId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyFloorPlan" ADD CONSTRAINT "PropertyFloorPlan_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyFloorPlan" ADD CONSTRAINT "PropertyFloorPlan_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "propertyware_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorPlanExtractionJob" ADD CONSTRAINT "FloorPlanExtractionJob_floorPlanId_fkey" FOREIGN KEY ("floorPlanId") REFERENCES "PropertyFloorPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyFloor" ADD CONSTRAINT "PropertyFloor_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyFloor" ADD CONSTRAINT "PropertyFloor_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "propertyware_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyArea" ADD CONSTRAINT "PropertyArea_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyArea" ADD CONSTRAINT "PropertyArea_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "propertyware_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyArea" ADD CONSTRAINT "PropertyArea_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "PropertyFloor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyArea" ADD CONSTRAINT "PropertyArea_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyArea" ADD CONSTRAINT "PropertyArea_markerUpdatedById_fkey" FOREIGN KEY ("markerUpdatedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyArea" ADD CONSTRAINT "PropertyArea_sourceFloorPlanId_fkey" FOREIGN KEY ("sourceFloorPlanId") REFERENCES "PropertyFloorPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaChecklistItem" ADD CONSTRAINT "AreaChecklistItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaChecklistItem" ADD CONSTRAINT "AreaChecklistItem_propertyAreaId_fkey" FOREIGN KEY ("propertyAreaId") REFERENCES "PropertyArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaChecklistItem" ADD CONSTRAINT "AreaChecklistItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyAreaAlias" ADD CONSTRAINT "PropertyAreaAlias_propertyAreaId_fkey" FOREIGN KEY ("propertyAreaId") REFERENCES "PropertyArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyAreaAlias" ADD CONSTRAINT "PropertyAreaAlias_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_propertywareBuildingId_fkey" FOREIGN KEY ("propertywareBuildingId") REFERENCES "propertyware_buildings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_propertywareUnitId_fkey" FOREIGN KEY ("propertywareUnitId") REFERENCES "propertyware_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_propertywareLeaseId_fkey" FOREIGN KEY ("propertywareLeaseId") REFERENCES "propertyware_leases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_baselineInspectionId_fkey" FOREIGN KEY ("baselineInspectionId") REFERENCES "Inspection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_parentInspectionId_fkey" FOREIGN KEY ("parentInspectionId") REFERENCES "Inspection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_finalizedById_fkey" FOREIGN KEY ("finalizedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "propertyware_portfolio_owners" ADD CONSTRAINT "propertyware_portfolio_owners_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "propertyware_portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "propertyware_portfolio_owners" ADD CONSTRAINT "propertyware_portfolio_owners_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "propertyware_owners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "propertyware_buildings" ADD CONSTRAINT "propertyware_buildings_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "propertyware_portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "propertyware_units" ADD CONSTRAINT "propertyware_units_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "propertyware_buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "propertyware_units" ADD CONSTRAINT "propertyware_units_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "propertyware_portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "propertyware_leases" ADD CONSTRAINT "propertyware_leases_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "propertyware_portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "propertyware_leases" ADD CONSTRAINT "propertyware_leases_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "propertyware_buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "propertyware_leases" ADD CONSTRAINT "propertyware_leases_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "propertyware_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "propertyware_sync_run_entities" ADD CONSTRAINT "propertyware_sync_run_entities_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "propertyware_sync_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "propertyware_sync_errors" ADD CONSTRAINT "propertyware_sync_errors_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "propertyware_sync_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionAssignment" ADD CONSTRAINT "InspectionAssignment_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionAssignment" ADD CONSTRAINT "InspectionAssignment_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionAssignment" ADD CONSTRAINT "InspectionAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionAssignment" ADD CONSTRAINT "InspectionAssignment_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionAssignment" ADD CONSTRAINT "InspectionAssignment_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "InspectionAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "InspectionPhoto" ADD CONSTRAINT "InspectionPhoto_inspectionAreaId_fkey" FOREIGN KEY ("inspectionAreaId") REFERENCES "InspectionArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionPhoto" ADD CONSTRAINT "InspectionPhoto_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "InspectionFinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionPhoto" ADD CONSTRAINT "InspectionPhoto_capturedById_fkey" FOREIGN KEY ("capturedById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "InspectionReportShare" ADD CONSTRAINT "InspectionReportShare_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionReportShare" ADD CONSTRAINT "InspectionReportShare_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingReview" ADD CONSTRAINT "FindingReview_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "InspectionFinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingReview" ADD CONSTRAINT "FindingReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionAreaComparison" ADD CONSTRAINT "InspectionAreaComparison_comparisonId_fkey" FOREIGN KEY ("comparisonId") REFERENCES "InspectionComparison"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PetObservation" ADD CONSTRAINT "PetObservation_petCandidateId_fkey" FOREIGN KEY ("petCandidateId") REFERENCES "PetCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_petCandidateId_fkey" FOREIGN KEY ("petCandidateId") REFERENCES "PetCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

