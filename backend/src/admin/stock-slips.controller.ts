import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MOST_SLIP_LINES, MOST_STOCK_QUANTITY, STOCK_SLIP_KINDS, type PostStockSlipInput, type ReverseStockSlipInput, type StockSlipKind } from '@texasrenters/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { StockSlipsService } from './stock-slips.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Null is "none"; anything else is checked. The form sends the whole slip, so every field is there. */
const GIVEN = (_: object, value: unknown) => value !== null;

export class StockSlipLineDto {
  @IsUUID() itemId!: string;
  @IsInt() @Min(1) @Max(MOST_STOCK_QUANTITY) quantity!: number;
}

/**
 * Every field of each contract input is named in its DTO: the validation pipe
 * refuses any field it does not know (stock-slips.spec.ts runs the pipe).
 */
export class PostStockSlipDto implements Required<PostStockSlipInput> {
  @IsIn(STOCK_SLIP_KINDS) kind!: StockSlipKind;
  @ValidateIf(GIVEN) @IsUUID() technicianId!: string | null;
  @ValidateIf(GIVEN) @IsUUID() fromPlaceId!: string | null;
  @ValidateIf(GIVEN) @IsUUID() toPlaceId!: string | null;
  @ValidateIf(GIVEN) @IsUUID() inspectionId!: string | null;
  @ValidateIf(GIVEN) @IsString() @MaxLength(500) note!: string | null;
  @IsUUID() requestKey!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MOST_SLIP_LINES) @ValidateNested({ each: true }) @Type(() => StockSlipLineDto) lines!: StockSlipLineDto[];
}

export class ReverseStockSlipDto implements Required<ReverseStockSlipInput> {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class StockSlipListQueryDto {
  @IsOptional() @IsUUID() technicianId?: string;
}

export class StockSlipChoicesQueryDto {
  @IsOptional() @IsUUID() technicianId?: string;
  @IsOptional() @Matches(DAY) day?: string;
}

/**
 * Withdrawals, returns and moves (2026-11-19, phase 5). Read with
 * `inventory:read`; recorded and reversed with `inventory:withdraw` on top of
 * it, which no API key may hold. Every slip and reversal is audited.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/inventory/slips')
export class StockSlipsController {
  constructor(@Inject(StockSlipsService) private readonly slips: StockSlipsService) {}

  @Get()
  @RequirePermissions('inventory:read')
  list(@Req() request: AuthenticatedRequest, @Query() query: StockSlipListQueryDto) {
    return this.slips.list(request.user, query.technicianId);
  }

  @Get('choices')
  @RequirePermissions('inventory:read', 'inventory:withdraw')
  choices(@Req() request: AuthenticatedRequest, @Query() query: StockSlipChoicesQueryDto) {
    return this.slips.choices(request.user, query.technicianId, query.day);
  }

  @Post()
  @RequirePermissions('inventory:read', 'inventory:withdraw')
  @HttpCode(200)
  post(@Req() request: AuthenticatedRequest, @Body() body: PostStockSlipDto) {
    return this.slips.post(request.user, body);
  }

  @Post(':slipId/reverse')
  @RequirePermissions('inventory:read', 'inventory:withdraw')
  @HttpCode(200)
  reverse(@Req() request: AuthenticatedRequest, @Param('slipId', ParseUUIDPipe) slipId: string, @Body() body: ReverseStockSlipDto) {
    return this.slips.reverse(request.user, slipId, body);
  }
}
