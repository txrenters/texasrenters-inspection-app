import { AreaCategory, AreaEnvironment, PhotoCaptureType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class TechnicianCreateAreaDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
  @IsEnum(AreaEnvironment) environment!: AreaEnvironment;
  @IsOptional() @IsEnum(AreaCategory) category?: AreaCategory;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) floorName?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

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
  @IsOptional() @IsIn(['ALL', 'DEFECTS', 'SUMMARIES']) kind?: 'ALL' | 'DEFECTS' | 'SUMMARIES';
}

export class TechnicianReasonDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class TechnicianMediaUploadDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,128}$/)
  idempotencyKey!: string;

  @Type(() => Number) @IsInt() @Min(1) @Max(7200) durationSeconds!: number;

  @IsOptional() @IsString() @MaxLength(60) captureGuidelineVersion?: string;
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_-]{8,128}$/) captureSessionId?: string;
  @IsOptional() @IsString() @MaxLength(60) capturePolicyVersion?: string;
  @IsOptional()
  @IsIn([
    'COMPLETE',
    'LIKELY_COMPLETE',
    'INCOMPLETE',
    'SENSOR_UNAVAILABLE',
    'LOW_CONFIDENCE',
    'MANUALLY_CONFIRMED',
  ])
  coverageStatus?: string;
  @IsOptional() @IsIn(['HIGH', 'MEDIUM', 'LOW', 'UNAVAILABLE']) sensorConfidence?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(720) clockwiseRotationDegrees?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(720) counterClockwiseRotationDegrees?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(360) startHeadingDegrees?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(360) endHeadingDegrees?: number;
  @IsOptional() @Transform(({ value }) => parseMultipartBoolean(value)) @IsBoolean() returnedToStart?: boolean;
  @IsOptional() @Transform(({ value }) => parseMultipartBoolean(value)) @IsBoolean() sensorSupported?: boolean;
  @IsOptional() @Transform(({ value }) => parseMultipartBoolean(value)) @IsBoolean() manualConfirmation?: boolean;
  @IsOptional() @Transform(({ value }) => parseMultipartBoolean(value)) @IsBoolean() evidenceComplete?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(500) snapshotCount?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(500) findingMarkerCount?: number;
}

const ADDITIONAL_VIDEO_CATEGORIES = [
  'ADDITIONAL_DAMAGE',
  'APPLIANCE_TEST',
  'PLUMBING',
  'ELECTRICAL',
  'PEST',
  'PET_EVIDENCE',
  'SAFETY',
  'EXTERIOR',
  'FOLLOW_UP',
  'REINSPECTION',
  'OTHER',
];

export class TechnicianAdditionalVideoDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,128}$/) idempotencyKey!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(7200) durationSeconds!: number;
  @IsString() @MinLength(1) @MaxLength(120) label!: string;
  @IsOptional() @IsIn(ADDITIONAL_VIDEO_CATEGORIES) category?: string;
  @IsOptional() @IsUUID() relatedFindingId?: string;
  @IsOptional() @IsString() @MaxLength(60) captureGuidelineVersion?: string;
}

export class TechnicianPhotoUploadDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,128}$/) idempotencyKey!: string;
  @IsEnum(PhotoCaptureType) captureType!: PhotoCaptureType;
  @IsOptional() @IsUUID() findingId?: string;
  @IsOptional() @IsString() @MaxLength(120) label?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1000) sequenceNumber?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20000) width?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20000) height?: number;
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_-]{8,128}$/) recordingSessionId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(7_200_000) videoTimestampMs?: number;
  @IsOptional()
  @IsIn([
    'NATIVE_STILL_DURING_VIDEO',
    'VIDEO_FRAME_EXTRACTION',
    'SEPARATE_PHOTO_CAPTURE',
  ])
  captureSource?: string;
}

function parseMultipartBoolean(value: unknown) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
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
