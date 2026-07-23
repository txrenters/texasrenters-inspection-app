import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { PERMISSION_KEYS } from '@texasrenters/shared';

const PERMISSION_VALUES = [...PERMISSION_KEYS];

export class AccessListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  search?: string;
  @IsOptional() @IsIn(['true', 'false', 'all']) active?: string;
}

export class CreateRoleDto {
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(280) description?: string;
  @IsArray()
  @ArrayUnique()
  @IsIn(PERMISSION_VALUES, { each: true })
  permissions!: string[];
}

export class UpdateRoleDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(280) description?: string;
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(PERMISSION_VALUES, { each: true })
  permissions?: string[];
}

export class CreateUserDto {
  @IsEmail() @MaxLength(320) email!: string;
  @IsString() @MinLength(2) @MaxLength(120) displayName!: string;
  @IsArray() @ArrayNotEmpty() @ArrayUnique() @IsUUID('all', { each: true }) roleIds!: string[];
}

export class UpdateUserDto {
  @IsString() @MinLength(2) @MaxLength(120) displayName!: string;
}

export class UpdateUserStatusDto {
  @IsBoolean() isActive!: boolean;
}

export class SetUserRolesDto {
  @IsArray() @ArrayUnique() @IsUUID('all', { each: true }) roleIds!: string[];
}
