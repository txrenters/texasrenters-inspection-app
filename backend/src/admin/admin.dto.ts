import { AiProvider, AreaCategory, AreaEnvironment, InspectionType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class PaginationDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  search?: string;
}

export class PropertyListQueryDto extends PaginationDto {
  @IsOptional() @IsUUID() portfolioId?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(40) state?: string;
  @IsOptional() @IsIn(['true', 'false']) active?: string;
  @IsOptional() @IsIn(['true', 'false']) hasUpcomingMoveOut?: string;
  @IsOptional() @IsIn(['true', 'false']) hasUnassignedInspection?: string;
}

export class PortfolioListQueryDto extends PaginationDto {}

export class UnitListQueryDto extends PaginationDto {
  @IsOptional() @IsIn(['true', 'false']) active?: string;
  @IsOptional() @IsIn(['true', 'false']) vacant?: string;
}

export class LeaseListQueryDto extends PaginationDto {
  @IsOptional() @IsString() @MaxLength(80) status?: string;
  @IsOptional() @IsDateString() scheduledMoveOutFrom?: string;
  @IsOptional() @IsDateString() scheduledMoveOutTo?: string;
  @IsOptional() @IsIn(['true', 'false']) active?: string;
}

export class InspectionListQueryDto extends PaginationDto {
  @IsOptional() @IsString() portfolioId?: string;
  @IsOptional() @IsUUID() propertyId?: string;
  @IsOptional() @IsUUID() technicianId?: string;
  @IsOptional() @IsEnum(InspectionType) inspectionType?: InspectionType;
  @IsOptional() @IsIn(['ASSIGNED', 'UNASSIGNED']) assignmentStatus?: string;
  @IsOptional()
  @IsIn(['SCHEDULED', 'IN_PROGRESS', 'PROCESSING', 'REVIEW_REQUIRED', 'COMPLETED', 'CANCELLED'])
  status?: string;
  @IsOptional() @IsDateString() scheduledFrom?: string;
  @IsOptional() @IsDateString() scheduledTo?: string;
  @IsOptional() @IsIn(['true', 'false']) unassignedOnly?: string;
}

export class CreateAdminInspectionDto {
  @IsUUID() propertyId!: string;
  @IsOptional() @IsUUID() unitId?: string;
  @IsOptional() @IsUUID() leaseId?: string;
  @IsOptional() @IsUUID() technicianId?: string;
  @IsDateString() scheduledAt!: string;
  @IsOptional() @IsEnum(InspectionType) inspectionType: InspectionType = InspectionType.MOVE_IN;
  @IsOptional() @IsIn(['STANDARD', 'HIGH']) priority = 'STANDARD';
  @IsOptional() @IsString() @MaxLength(2000) internalNotes?: string;
  @IsOptional() @IsString() @MaxLength(120) idempotencyKey?: string;
}

export class UpdateAdminInspectionDto {
  @IsOptional() @IsDateString() scheduledAt?: string;
  @IsOptional() @IsIn(['STANDARD', 'HIGH']) priority?: string;
  @IsOptional() @IsString() @MaxLength(2000) internalNotes?: string;
  // Finalization (COMPLETED) is a separate, permission-gated action; this generic
  // update only allows cancellation.
  @IsOptional() @IsIn(['CANCELLED']) status?: string;
  @IsOptional() @IsString() @MaxLength(500) cancellationReason?: string;
}

/** Finalize (complete) an inspection — a human-only decision (spec §11). */
export class FinalizeInspectionDto {
  // Required only to override the unresolved-required-items block; the override
  // is recorded in the audit trail.
  @IsOptional() @IsString() @MinLength(2) @MaxLength(500) overrideReason?: string;
}

/** Mark an inspection TBD / pending-finalization (spec §11). */
export class InspectionTbdDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** Require a follow-up inspection with an optional planned date and tasks. */
export class InspectionFollowUpDto {
  @IsOptional() @IsDateString() dueAt?: string;
  @IsOptional() @IsString() @MaxLength(2000) tasks?: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** Move an inspection into administrator review / request more evidence. */
export class InspectionUnderReviewDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** Merge a duplicate inspection area into another within the same inspection. */
export class MergeInspectionAreasDto {
  @IsUUID() sourceAreaId!: string;
  @IsUUID() targetAreaId!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

const COMPARISON_CLASSIFICATIONS = [
  'UNCHANGED',
  'IMPROVED',
  'NEW_DAMAGE',
  'WORSENED',
  'RESOLVED',
  'MISSING_BASELINE',
  'MISSING_MOVE_OUT_EVIDENCE',
  'NOT_COMPARABLE',
  'REQUIRES_REVIEW',
] as const;

/** Approve or reject a move-in vs move-out comparison (spec §12). */
export class ComparisonReviewDto {
  @IsIn(['APPROVED', 'REJECTED']) decision!: 'APPROVED' | 'REJECTED';
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/** Override a single area comparison's classification, with an audit trail. */
export class AreaComparisonOverrideDto {
  @IsIn(COMPARISON_CLASSIFICATIONS) classification!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** Configure a charge rule (spec §13/§14) — e.g. the unauthorized-pet amount. */
export class ChargeRuleDto {
  @IsOptional() @IsString() @MaxLength(60) code?: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000) amount!: number;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional()
  @IsIn(['PER_UNIQUE_ENTITY', 'FLAT', 'PER_UNIT'])
  calculationType?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** A technician's pet observation (evidence only) during an occupied inspection. */
export class PetObservationDto {
  @IsString() @MinLength(1) @MaxLength(120) temporaryLabel!: string;
  @IsString() @MinLength(1) @MaxLength(60) species!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MaxLength(500) characteristics?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsUUID() propertyAreaId?: string;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) photoIds?: string[];
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) mediaIds?: string[];
  @IsOptional() @IsUUID() possibleDuplicateOfId?: string;
}

/** A reviewer's determination for a pet candidate (uniqueness + authorization). */
export class PetCandidateReviewDto {
  @IsIn(['PENDING_REVIEW', 'UNIQUE_PET', 'DUPLICATE', 'INSUFFICIENT_EVIDENCE']) reviewStatus!: string;
  @IsOptional() @IsIn(['UNKNOWN', 'AUTHORIZED', 'UNAUTHORIZED']) authorizationStatus?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/** An administrator-created charge (e.g. a damage charge referencing a finding). */
export class CreateChargeDto {
  @IsOptional() @IsString() @MaxLength(60) chargeCode?: string;
  @IsString() @MinLength(1) @MaxLength(300) description!: string;
  @IsOptional() @IsUUID() propertyAreaId?: string;
  @IsOptional() @IsUUID() findingId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) quantity?: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000) unitAmount!: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** A human decision on a proposed charge (spec §14). AI never reaches this. */
export class ChargeReviewDto {
  @IsIn(['APPROVE', 'REJECT', 'ADJUST', 'WAIVE']) decision!: string;
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  approvedAmount?: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class FindingReviewDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

export class CreateReportShareDto {
  @IsOptional() @IsEmail() @MaxLength(320) recipientEmail?: string;
}

export class TestMailDto {
  @IsEmail() @MaxLength(320) recipientEmail!: string;
}

export class FindingRejectDto {
  @IsString() @MinLength(2) @MaxLength(1000) reason!: string;
}

export class AdminFindingsQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['PENDING_REVIEW', 'APPROVED', 'EDITED', 'REJECTED', 'REINSPECTION_REQUESTED'])
  reviewStatus?: string;
  // DEFECTS = chargeable review queue; SUMMARIES = informational room summaries.
  @IsOptional() @IsIn(['ALL', 'DEFECTS', 'SUMMARIES']) kind?: 'ALL' | 'DEFECTS' | 'SUMMARIES';
}

export class AssignmentDto {
  @IsUUID() technicianId!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsString() @MaxLength(120) idempotencyKey?: string;
}

export class UnassignDto {
  @IsString() @MinLength(2) @MaxLength(500) reason!: string;
}

export class AssignmentListQueryDto extends PaginationDto {
  @IsOptional() @IsUUID() inspectionId?: string;
  @IsOptional() @IsUUID() technicianId?: string;
  @IsOptional() @IsUUID() propertyId?: string;
  @IsOptional()
  @IsIn([
    'SCHEDULED',
    'IN_PROGRESS',
    'TECHNICIAN_SUBMITTED',
    'PROCESSING',
    'REVIEW_REQUIRED',
    'UNDER_REVIEW',
    'TBD',
    'FOLLOW_UP_REQUIRED',
    'COMPLETED',
    'CANCELLED',
  ])
  inspectionStatus?: string;
  @IsOptional() @IsIn(['ASSIGNED', 'REASSIGNED', 'UNASSIGNED']) assignmentStatus?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(['true', 'false']) includeUnassigned?: string;
}

export class AuditListQueryDto extends PaginationDto {}

export class TechnicianListQueryDto extends PaginationDto {
  @IsOptional() @IsIn(['true', 'false']) active?: string;
}

export class TechnicianStatusDto {
  @IsBoolean() isActive!: boolean;
}

export class UpdateAiRoutingDto {
  @IsEnum(AiProvider) activeProvider!: AiProvider;
}

export class UpdateAiProviderDto {
  @IsString() @MinLength(2) @MaxLength(120) modelId!: string;
  @IsOptional() @IsString() @MinLength(20) @MaxLength(500) apiKey?: string;
  @IsOptional() @IsBoolean() clearApiKey?: boolean;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1_000)
  @Max(2_000_000_000)
  monthlyTokenBudget?: number | null;
}

export class CreateTechnicianDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(2) @MaxLength(120) displayName!: string;
}

export class CreatePropertyAreaDto {
  @IsOptional() @IsUUID() unitId?: string;
  @IsString() @MinLength(1) @MaxLength(80) floorName!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(500) inspectionOrder!: number;
  @IsBoolean() isRequired!: boolean;
  @IsOptional() @IsEnum(AreaEnvironment) environment?: AreaEnvironment;
  @IsOptional() @IsEnum(AreaCategory) category?: AreaCategory;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class UploadFloorPlanDto {
  @IsOptional() @IsUUID() unitId?: string;
}

export class UpdatePropertyAreaDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) floorName?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) inspectionOrder?: number;
  @IsOptional() @IsBoolean() isRequired?: boolean;
  @IsOptional() @IsEnum(AreaEnvironment) environment?: AreaEnvironment;
  @IsOptional() @IsEnum(AreaCategory) category?: AreaCategory;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class RejectPropertyAreaDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class ApprovePropertyAreasDto {
  @ArrayMinSize(1) @IsUUID('4', { each: true }) areaIds!: string[];
}
