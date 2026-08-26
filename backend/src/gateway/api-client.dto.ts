import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsIP,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { MACHINE_GRANTABLE_PERMISSIONS } from '@texasrenters/shared';

const GRANTABLE = [...MACHINE_GRANTABLE_PERMISSIONS];
const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Whether a permission lets a client change something.
 *
 * The catalog is `resource:action`, and `read` is the only non-mutating action
 * in it — so this stays correct as keys are added, rather than needing a list
 * kept in step by hand.
 */
export function isWritePermission(permission: string) {
  return !permission.endsWith(':read');
}

export class ApiClientListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsIn(['true', 'false', 'all']) active?: string;
}

export class CreateApiClientDto {
  /** Display name, unique per organization. This is what an operator revokes by. */
  @Transform(trimmed) @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(280) description?: string;
  @IsOptional() @IsIn(['LIVE', 'TEST']) environment?: string;
  /**
   * Permission keys this integration may exercise. Restricted to
   * MACHINE_GRANTABLE_PERMISSIONS — the keys that let a credential escalate
   * itself or destroy evidence irreversibly are refused here, at issue time,
   * rather than only where they would be used.
   */
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(GRANTABLE.length)
  @IsIn(GRANTABLE, { each: true })
  permissions!: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(6_000) rateLimitPerMinute?: number;
  @IsOptional() @IsBoolean() requireSignature?: boolean;
  /** Source addresses this client may call from. Empty means any address. */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsIP(undefined, { each: true }) allowedIps?: string[];
}

export class UpdateApiClientDto {
  @IsOptional() @Transform(trimmed) @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(280) description?: string;
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(GRANTABLE.length)
  @IsIn(GRANTABLE, { each: true })
  permissions?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(6_000) rateLimitPerMinute?: number;
  @IsOptional() @IsBoolean() requireSignature?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsIP(undefined, { each: true }) allowedIps?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateApiClientKeyDto {
  /** What this key is for, so revoking the right one is not a guess from timestamps. */
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(80) label?: string;
  /** When the key stops working. Omit for a key with no expiry. */
  @IsOptional() @IsISO8601() expiresAt?: string;
}
