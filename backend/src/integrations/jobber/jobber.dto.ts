import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * A slice of the past to pull, instead of the rolling week.
 *
 * The scheduled sync looks back seven days and always will, so a visit older
 * than that is invisible to every run however often it runs -- which is why
 * only the current quarter has ever appeared in the console. The office
 * (2026-09-20) wants the quarter before it: "can we fetch all the q3 from
 * jobber, it has the +15 days also cause we want to be able to see the q3
 * visits also". Both days or neither; the page cap bounds the run either way.
 */
/** An action on the day's comparison that names one inspection. */
export class JobberDayInspectionActionDto {
  @IsUUID() inspectionId!: string;
}

/** Send our time to Jobber; with `technician`, our technician too (needs Assign). */
export class JobberDayPushDto extends JobberDayInspectionActionDto {
  @IsOptional() @IsBoolean() technician?: boolean;
}

/** An action on a Jobber visit that has no inspection here. */
export class JobberDayVisitActionDto {
  @IsString() @MaxLength(200) jobberVisitId!: string;
}

export class JobberSyncWindowDto {
  /** `YYYY-MM-DD`, the first day to pull. */
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) startAfter?: string;
  /** `YYYY-MM-DD`, the last day to pull. */
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) startBefore?: string;
}

export class JobberLinkQueueQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class JobberVisitImportQueryDto {
  /** Defaults to the two states that need a person. */
  @IsOptional()
  @IsIn(['PENDING', 'IMPORTED', 'UNMATCHED_PROPERTY', 'REJECTED', 'IGNORED'])
  status?: 'PENDING' | 'IMPORTED' | 'UNMATCHED_PROPERTY' | 'REJECTED' | 'IGNORED';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class JobberLinkPropertyDto {
  /** A `PropertywareBuilding` id. Validated against the organization before use
   * — this decides which property every future visit inspects. */
  @IsUUID()
  buildingId!: string;

  @IsOptional()
  @IsUUID()
  unitId?: string;

  @IsOptional()
  @IsUUID()
  leaseId?: string;
}

export class JobberIgnoreLinkDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
