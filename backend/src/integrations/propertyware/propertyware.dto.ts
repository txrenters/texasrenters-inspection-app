import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

import { PROPERTYWARE_ENTITIES, type PropertywareEntity } from './propertyware.constants';

export class PropertywareSyncRequestDto {
  @ApiProperty({ enum: PROPERTYWARE_ENTITIES, isArray: true })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(PROPERTYWARE_ENTITIES, { each: true })
  entities!: PropertywareEntity[];

  @ApiPropertyOptional({ enum: ['initial', 'incremental'], default: 'incremental' })
  @IsOptional()
  @IsIn(['initial', 'incremental'])
  mode: 'initial' | 'incremental' = 'incremental';
}

export class CatalogQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
  @ApiPropertyOptional() @IsOptional() @IsString() portfolioId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
}

export class PropertywareSyncRunQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
  @IsOptional()
  @IsIn(['QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'])
  status?: string;
  @IsOptional() @IsIn(['initial', 'incremental', 'reconciliation']) syncType?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

export class PropertywareSyncErrorQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
  @IsOptional() @IsIn(PROPERTYWARE_ENTITIES) entityType?: PropertywareEntity;
  @IsOptional() @IsIn(['true', 'false']) resolved?: string;
}
