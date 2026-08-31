import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

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
