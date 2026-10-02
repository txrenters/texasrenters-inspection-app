import { VideoRecordingType } from '@prisma/client';
import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

import { MAX_GUIDANCE_LENGTH } from '../admin/ai-guidance.service';

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
