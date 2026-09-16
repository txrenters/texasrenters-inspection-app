import { TbpStopStatus } from '@prisma/client';
import { TBP_INSPECTION_TYPES, type TbpInspectionType } from '@texasrenters/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * The office's limits on a technician-day and the visit lengths they are
 * measured with. Any left out keep the plan's current values.
 */
export class PlanRoutingSettingsDto {
  /** Minutes an occupied inspection counts for in a day. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(240) occupiedVisitMinutes?: number;
  /** Minutes an HVAC inspection counts for in a day. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(240) hvacVisitMinutes?: number;
  /** Time spent inspecting in one technician-day: six hours is the office's rule. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(30) @Max(720) maxOnSiteMinutes?: number;
  /** Driving between one day's properties, first to last: ninety minutes is the office's rule. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(480) maxDriveMinutes?: number;

  /**
   * Days the office is closed besides weekends and US federal holidays, as
   * `YYYY-MM-DD`. Those are always left out; this is for any other day.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { each: true })
  holidays?: string[];
}

export class PlanQuarterDto extends PlanRoutingSettingsDto {
  @Type(() => Number) @IsInt() @Min(2020) @Max(2100) year!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(4) quarter!: number;
}

export class PlanStopListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  // A quarter is a few hundred stops and the review page shows them as one
  // list, so the ceiling is high enough to hold a whole plan in one request.
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) pageSize = 100;
  @IsOptional() @IsEnum(TbpStopStatus) status?: TbpStopStatus;
}

export class PlanStopTypeDto {
  @IsIn(TBP_INSPECTION_TYPES) inspectionType!: TbpInspectionType;
}

/** A coordinator's change to one visit in a draft. Anything left out stays as it is. */
export class PlanStopEditDto {
  /** The visit's day, `YYYY-MM-DD`, inside the plan's quarter. */
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) scheduledOn?: string;
  @IsOptional() @IsUUID('all') assignedTechnicianId?: string;
  /** One of the property's units, for a building of several. */
  @IsOptional() @IsUUID('all') propertywareUnitId?: string;
  /** Sent to Jobber as written, and keeps "Tenant Benefit Package". */
  @IsOptional() @IsString() @MaxLength(300) visitTitle?: string;
  /** Sent to Jobber as written, and names the inspection the visit is. */
  @IsOptional() @IsString() @MaxLength(4000) visitDetails?: string;
  /** Minutes on site, at most the plan's day on site. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(720) onSiteMinutes?: number;
  @IsOptional() @IsIn(TBP_INSPECTION_TYPES) inspectionType?: TbpInspectionType;
}

/** One row of the office's sheet: the property and the services line written for it. */
export class OfficeDetailsRowDto {
  @IsString() @MaxLength(200) address!: string;
  @IsOptional() @IsString() @MaxLength(100) city?: string | null;
  @IsOptional() @IsString() @MaxLength(20) postalCode?: string | null;
  @IsString() @MaxLength(2000) details!: string;
}

export class OfficeDetailsImportDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => OfficeDetailsRowDto)
  rows!: OfficeDetailsRowDto[];
}
