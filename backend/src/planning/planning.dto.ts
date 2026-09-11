import { TbpStopStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class PlanQuarterDto {
  @Type(() => Number) @IsInt() @Min(2020) @Max(2100) year!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(4) quarter!: number;

  /**
   * The days the office is closed, as `YYYY-MM-DD`.
   *
   * Stated rather than derived: a list of US federal holidays would be wrong
   * for the days this office actually closes and right for days it does not.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { each: true })
  holidays?: string[];
}

export class PlanStopListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  // A quarter is a few hundred stops and the review page shows them as one
  // list, so the ceiling is high enough to hold a whole plan in one request.
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) pageSize = 100;
  @IsOptional() @IsEnum(TbpStopStatus) status?: TbpStopStatus;
}
