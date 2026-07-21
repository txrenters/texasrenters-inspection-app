import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsMimeType,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreatePropertyDto {
  @ApiProperty() @IsString() @IsNotEmpty() name!: string;
  @ApiProperty() @IsString() @IsNotEmpty() addressLine1!: string;
  @ApiProperty() @IsString() @IsNotEmpty() city!: string;
  @ApiProperty({ default: 'TX' }) @IsString() @MaxLength(2) state = 'TX';
  @ApiProperty() @IsString() @IsNotEmpty() postalCode!: string;
}

export class UpdatePropertyDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() addressLine1?: string;
}

export class RegisterFloorPlanDto {
  @ApiProperty() @IsString() @IsNotEmpty() fileName!: string;
  @ApiProperty({ enum: ['application/pdf', 'image/jpeg', 'image/png'] })
  @IsMimeType()
  @IsIn(['application/pdf', 'image/jpeg', 'image/png'])
  mimeType!: string;
  @ApiProperty({ maximum: 20_000_000 }) @IsInt() @IsPositive() @Max(20_000_000) sizeBytes!: number;
}

export class CreateAreaDto {
  @ApiProperty() @IsString() @IsNotEmpty() floorName!: string;
  @ApiProperty() @IsString() @IsNotEmpty() name!: string;
  @ApiProperty() @IsInt() @IsPositive() inspectionOrder!: number;
  @ApiProperty() @IsBoolean() isRequired!: boolean;
}

export class UpdateAreaDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() floorName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @IsPositive() inspectionOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isRequired?: boolean;
}

export class AreaOrderDto {
  @ApiProperty({ type: [String] }) @IsArray() @IsUUID('4', { each: true }) areaIds!: string[];
}

export class CreateInspectionDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsUUID() technicianId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() scheduledAt!: string;
}

export class ReasonDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}

export class UploadSessionDto {
  @ApiProperty() @IsString() @IsNotEmpty() idempotencyKey!: string;
  @ApiProperty() @IsString() @IsNotEmpty() fileName!: string;
  @ApiProperty() @IsMimeType() mimeType!: string;
}

export class RegisterMediaDto {
  @ApiProperty() @IsString() @IsNotEmpty() providerUploadId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() providerMediaId!: string;
  @ApiProperty() @IsMimeType() mimeType!: string;
  @ApiProperty() @IsInt() @Min(1) durationSeconds!: number;
}

export class UpdateFindingDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() description?: string;
  @ApiPropertyOptional({ enum: ['low', 'medium', 'high'] })
  @IsOptional()
  @IsIn(['low', 'medium', 'high'])
  severity?: 'low' | 'medium' | 'high';
}

export class WebhookDto {
  @ApiProperty() @IsString() @IsNotEmpty() providerEventId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() eventType!: string;
}
