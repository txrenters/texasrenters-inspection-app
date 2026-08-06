import { VideoRecordingType } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

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
