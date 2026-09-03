import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Everything here arrives from an anonymous caller, so every field is capped.
 *
 * The endpoint has to accept writes without a session — an error raised before
 * sign-in has none, and those are the reports worth having most — so the limits
 * are the only thing standing between this table and anyone who finds the URL.
 * They are deliberately tighter than the data could ever legitimately need: a
 * stack the client has already truncated to six lines does not reach 4 kB.
 */

/** One entry from a client's log. */
export class ClientErrorEntryDto {
  /**
   * The client's own id for this entry.
   *
   * Paired with `installId` it is the deduplicating key, which is what lets a
   * handset re-send its whole log without creating a second copy of a crash it
   * already delivered.
   */
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  id!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2_000)
  message!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(8_000)
  stack?: string;

  /** The client's own label for where it was raised, e.g. `update-fetch`. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  context?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  fatal?: boolean;

  /** When the client says it happened. */
  @ApiProperty()
  @IsISO8601()
  at!: string;
}

export class ReportClientErrorsDto {
  /**
   * Stable per install or per browser, and never a person.
   *
   * It is what makes one handset's story readable end to end without knowing
   * who was holding it, and half of the deduplicating key.
   */
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  installId!: string;

  @ApiProperty({ enum: ['MOBILE', 'CONSOLE'] })
  @IsIn(['MOBILE', 'CONSOLE'])
  source!: 'MOBILE' | 'CONSOLE';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  platform?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  appVersion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  buildId?: string;

  /**
   * The API address the client was actually using.
   *
   * The first question asked of every report of this kind, and the client is
   * the only thing that knows the answer.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  apiBaseUrl?: string;

  /**
   * Capped at the size of the handset's own log, which keeps twenty entries.
   * A client with more than that to say is not reporting; it is looping.
   */
  @ApiProperty({ type: [ClientErrorEntryDto] })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ClientErrorEntryDto)
  entries!: ClientErrorEntryDto[];
}
