import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class TechnicianInspectionListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
  @IsOptional()
  @IsIn(['SCHEDULED', 'IN_PROGRESS', 'PROCESSING', 'REVIEW_REQUIRED', 'COMPLETED'])
  status?: string;
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  search?: string;
}

export class TechnicianFindingsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
  @IsOptional()
  @IsIn(['PENDING_REVIEW', 'APPROVED', 'EDITED', 'REJECTED', 'REINSPECTION_REQUESTED'])
  reviewStatus?: string;
}

export class TechnicianReasonDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class TechnicianNoteDto {
  @IsString() @MaxLength(2000) note!: string;
}

export class MobilePushDeviceDto {
  @IsString()
  @Matches(/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/)
  expoPushToken!: string;

  @IsIn(['ios', 'android'])
  platform!: 'ios' | 'android';
}

export class RemoveMobilePushDeviceDto {
  @IsString()
  @Matches(/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/)
  expoPushToken!: string;
}
