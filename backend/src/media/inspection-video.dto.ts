import { PhotoCaptureType, VideoRecordingType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { MAX_GUIDANCE_LENGTH } from '../admin/ai-guidance.service';
import { MAX_EXTRACTED_FRAMES } from '../technician/marker-frames';

/** A moment marked during a take, and the kind of photograph it stands for. */
export class FrameMarkerDto {
  @IsInt() @Min(0) atMs!: number;
  @IsEnum(PhotoCaptureType) captureType!: PhotoCaptureType;
}

/** The guided capture's own account of a take; the multipart upload's fields, as JSON. */
export class RecordingCaptureDto {
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_-]{8,128}$/) captureSessionId?: string;
  @IsOptional() @IsString() @MaxLength(60) capturePolicyVersion?: string;
  @IsOptional()
  @IsIn(['COMPLETE', 'LIKELY_COMPLETE', 'INCOMPLETE', 'SENSOR_UNAVAILABLE', 'LOW_CONFIDENCE', 'MANUALLY_CONFIRMED'])
  coverageStatus?: string;
  @IsOptional() @IsIn(['HIGH', 'MEDIUM', 'LOW', 'UNAVAILABLE']) sensorConfidence?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(720) clockwiseRotationDegrees?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(720) counterClockwiseRotationDegrees?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(360) startHeadingDegrees?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(360) endHeadingDegrees?: number;
  @IsOptional() @IsBoolean() returnedToStart?: boolean;
  @IsOptional() @IsBoolean() sensorSupported?: boolean;
  @IsOptional() @IsBoolean() manualConfirmation?: boolean;
  @IsOptional() @IsBoolean() evidenceComplete?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(500) snapshotCount?: number;
  @IsOptional() @IsInt() @Min(0) @Max(500) findingMarkerCount?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EXTRACTED_FRAMES)
  @ValidateNested({ each: true })
  @Type(() => FrameMarkerDto)
  frameMarkers?: FrameMarkerDto[];
}

/**
 * What the device declares before it is allowed to upload.
 *
 * Every value here is a claim by the client and is validated again server-side;
 * the size and duration are additionally enforced by Cloudflare itself through
 * the tus `Upload-Length` and `maxdurationseconds` we set from them, so a lie
 * cannot become a stored oversized video.
 */
export class CreateUploadSessionDto {
  @IsUUID()
  inspectionAreaId!: string;

  @IsOptional()
  @IsEnum(VideoRecordingType)
  recordingType?: VideoRecordingType;

  @IsString()
  @MaxLength(255)
  filename!: string;

  @IsString()
  @MaxLength(100)
  mimeType!: string;

  @IsInt()
  @IsPositive()
  fileSize!: number;

  @IsInt()
  @IsPositive()
  durationSeconds!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  localQueueId?: string;

  /**
   * Client-generated and stable across retries of the same recording. Stored as
   * the unique `providerMediaId`, so a repeated request returns the existing
   * session instead of creating a second Cloudflare video.
   */
  @IsString()
  @MaxLength(200)
  idempotencyKey!: string;

  @IsOptional()
  @IsISO8601()
  recordedAt?: string;

  /**
   * How the walkthrough was filmed, and the moments marked while filming.
   *
   * The multipart upload always carried this; the direct-to-Cloudflare one did
   * not, so every Stream recording reached the console with no coverage
   * summary, and an Android phone had to cut its marked frames itself
   * (2026-10-06). Optional: an older phone sends none.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => RecordingCaptureDto)
  capture?: RecordingCaptureDto;
}

/**
 * A still the reviewer wants cut from a recording.
 *
 * `atMs` rather than seconds because the technician's own markers are recorded
 * in milliseconds, so a reviewer clicking one lands on exactly the frame that
 * was marked rather than a rounded second nearby.
 */
export class CaptureSnapshotDto {
  @IsInt() @Min(0) atMs!: number;
  /**
   * The checklist item this still evidences. Optional: a reviewer may capture a
   * frame that documents the room generally, and the report captions it with
   * the free-text label in that case.
   */
  @IsOptional() @IsUUID() checklistItemId?: string;
  @IsOptional() @IsString() @MaxLength(120) label?: string;
  /**
   * The finding this still evidences: a reviewer picking the frame that shows
   * it. Filed under the finding, and printed only once the finding is
   * approved, like every finding photograph.
   */
  @IsOptional() @IsUUID() findingId?: string;
}

/**
 * Draft house rules to try on one recording before saving them. Bounded as
 * the saved rules are; empty tries the analysis with no rules at all.
 */
export class PreviewAnalysisDto {
  @IsString() @MaxLength(MAX_GUIDANCE_LENGTH) houseRules!: string;
}
