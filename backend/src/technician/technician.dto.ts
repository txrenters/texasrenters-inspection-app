import { AreaCategory, AreaEnvironment, PhotoCaptureType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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

/**
 * Upper bound on frames one recording may ask the server to cut.
 *
 * Declared here rather than beside its helper: decorators evaluate when the
 * class is defined, so a const declared lower in the file is still in its
 * temporal dead zone by the time `@ArrayMaxSize` reads it.
 */
const MAX_FRAME_MARKERS = 60;

/**
 * Statuses a technician may filter their own list by.
 *
 * CANCELLED is deliberately absent. The list is scoped to `visibleStatuses`
 * (`not: CANCELLED`), and accepting it here would let a client ask for work the
 * unfiltered list refuses to show — turning a filter into a way around the
 * visibility rule.
 *
 * The rest of the enum is present because the handset groups statuses: its
 * "Submitted" chip covers everything handed to the office, which is
 * TECHNICIAN_SUBMITTED, PROCESSING, REVIEW_REQUIRED, UNDER_REVIEW, TBD,
 * FOLLOW_UP_REQUIRED and COMPLETED. The previous list held five of those and
 * could not express TECHNICIAN_SUBMITTED at all, so that chip had no
 * server-side filter available and fell back to slicing 25 records on-device.
 *
 * Declared above the class for the same temporal-dead-zone reason as
 * MAX_FRAME_MARKERS.
 */
export const TECHNICIAN_FILTERABLE_STATUSES = [
  'SCHEDULED',
  'IN_PROGRESS',
  'TECHNICIAN_SUBMITTED',
  'PROCESSING',
  'REVIEW_REQUIRED',
  'UNDER_REVIEW',
  'TBD',
  'FOLLOW_UP_REQUIRED',
  'COMPLETED',
] as const;

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

/**
 * Corrections to an area the technician added.
 *
 * Every field optional: this is a correction, and sending only the name should
 * not blank the rest. `isRequired` and `inspectionOrder` are deliberately
 * absent — those are scheduling decisions the office makes, not observations
 * from the field.
 */
export class TechnicianUpdateAreaDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;
  @IsOptional() @IsEnum(AreaEnvironment) environment?: AreaEnvironment;
  // Nullable so a category can be cleared, not only changed.
  @IsOptional() @IsEnum(AreaCategory) category?: AreaCategory | null;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class TechnicianInspectionListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
  /**
   * One status, or several as a comma-separated list.
   *
   * Plural because the handset's chips are groups, not statuses — "Submitted"
   * is seven of them. Sending the set lets the server do the filtering, so a
   * chip sees every matching record instead of whichever ones happened to land
   * in the first page.
   *
   * Express also hands back an array for a repeated `?status=A&status=B`, so
   * both spellings are normalised to the same thing rather than one of them
   * silently validating as a string and matching nothing.
   */
  @IsOptional()
  @Transform(({ value }) => {
    const raw: unknown[] = Array.isArray(value) ? value : [value];
    return raw
      .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : [entry]))
      .map((entry) => (typeof entry === 'string' ? entry.trim() : entry))
      .filter((entry) => entry !== '');
  })
  @IsArray()
  @ArrayMaxSize(TECHNICIAN_FILTERABLE_STATUSES.length)
  @IsIn(TECHNICIAN_FILTERABLE_STATUSES, { each: true })
  status?: string[];
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
  /**
   * Video offsets, in milliseconds, where the technician asked for a still.
   *
   * Bounded at both ends: a client cannot make the server run unbounded ffmpeg
   * passes, and a marker past the recording length simply yields no frame.
   */
  @IsOptional()
  @Transform(({ value }) => parseFrameMarkers(value))
  @IsArray()
  @ArrayMaxSize(MAX_FRAME_MARKERS)
  @IsInt({ each: true })
  @Min(0, { each: true })
  frameMarkersMs?: number[];
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
  /**
   * The checklist item this photograph evidences.
   *
   * Optional because plenty of shots document the room generally rather than
   * one item — forcing a choice would push technicians into filing overview
   * photographs under an arbitrary row. Validated server-side against the
   * area's own checklist, so a photo can never be filed under an item that
   * belongs to a different room.
   */
  @IsOptional() @IsUUID() checklistItemId?: string;
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

/**
 * Parses the comma-separated marker list sent as a multipart field.
 *
 * Multipart values are always strings, so the array arrives as "1200,4500".
 * Anything unparseable is dropped rather than rejected: a bad marker must not
 * fail an upload that carries the actual room video.
 */
function parseFrameMarkers(value: unknown) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  const parsed = value
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isInteger(entry) && entry >= 0);
  return [...new Set(parsed)].sort((left, right) => left - right).slice(0, MAX_FRAME_MARKERS);
}

function parseMultipartBoolean(value: unknown) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}

/**
 * One checklist item's assessment, as the printed report scores it.
 *
 * **Replace semantics.** The route is a PUT and this payload is the complete
 * assessment for that item: an omitted axis is stored as unassessed, not left
 * at its previous value. That keeps the stored row and the submitted form the
 * same thing, so a technician who clears a checkbox sees it cleared.
 *
 * Each axis is a nullable tri-state — true, false, or unassessed. The office's
 * existing reports leave rows blank, and "not assessed" is a different claim
 * from "No"; coercing the two would invent a defect nobody observed.
 */
export class ChecklistAssessmentDto {
  /**
   * Seconds into the area's recording when this was answered.
   *
   * Bounded rather than merely non-negative: a client sending a millisecond
   * value by mistake would otherwise store a timestamp days into a recording
   * that is minutes long, and the reviewer's seek would land nowhere.
   */
  @IsOptional() @IsInt() @Min(0) @Max(86_400) videoTimestampSeconds?: number | null;
  @IsOptional() @IsBoolean() isClean?: boolean | null;
  @IsOptional() @IsBoolean() isUndamaged?: boolean | null;
  @IsOptional() @IsBoolean() isWorking?: boolean | null;
  @IsOptional() @IsString() @MaxLength(2000) comment?: string | null;
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
