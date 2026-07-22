import { AiProvider, InspectionType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
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
  @IsOptional() @IsIn(['CANCELLED', 'COMPLETED']) status?: string;
  @IsOptional() @IsString() @MaxLength(500) cancellationReason?: string;
}

export class FindingReviewDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

export class CreateReportShareDto {
  @IsOptional() @IsEmail() @MaxLength(320) recipientEmail?: string;
}

export class FindingRejectDto {
  @IsString() @MinLength(2) @MaxLength(1000) reason!: string;
}

export class AdminFindingsQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['PENDING_REVIEW', 'APPROVED', 'EDITED', 'REJECTED', 'REINSPECTION_REQUESTED'])
  reviewStatus?: string;
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
  @IsIn(['SCHEDULED', 'IN_PROGRESS', 'PROCESSING', 'REVIEW_REQUIRED', 'COMPLETED', 'CANCELLED'])
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
  @IsOptional() @Type(() => Number) @IsInt() @Min(1_000) @Max(2_000_000_000)
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
}

export class UploadFloorPlanDto {
  @IsOptional() @IsUUID() unitId?: string;
}

export class UpdatePropertyAreaDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) floorName?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) inspectionOrder?: number;
  @IsOptional() @IsBoolean() isRequired?: boolean;
}

export class ApprovePropertyAreasDto {
  @ArrayMinSize(1) @IsUUID('4', { each: true }) areaIds!: string[];
}
